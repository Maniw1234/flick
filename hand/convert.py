#!/usr/bin/env python3
"""Converts a MediaPipe hand model (.tflite) into Flick's own small format (.fhm), which hand/engine.c runs.

usage: convert.py <model.tflite> <out.fhm>

The format is a short program for the engine plus its weights:
  "FHM1" | u32 JSON length | JSON (padded to 4 bytes) | weights as float16, already laid out for the kernels
The JSON names the input and output tensors, the arena size (floats) and the ops. Every op is a list of ints: its code,
then arena offsets (floats) and sizes; weight offsets count float16 values from the start of the weights. The engine
expands the weights to float32 once, at load.

Only the ops the hand models use are handled: CONV_2D, DEPTHWISE_CONV_2D, ADD, PRELU, PAD (zero channels at the
end), MAX_POOL_2D (2x2, stride 2), RESIZE_BILINEAR (x2, half-pixel centres), MEAN (over height and width),
FULLY_CONNECTED, LOGISTIC, RESHAPE (shares its input's memory) and CONCATENATION on axis 1. DEQUANTIZE (float16
weights) is done here."""
import json, struct, sys
import numpy as np
import tflite_reader as tfl

# op codes shared with engine.c
CONV, CONV1, DW, ADD, PRELU, PADC, MAXPOOL2, RESIZE2X, MEAN, FC, SIGMOID, COPY = range(1, 13)
ACT = {0: 0, 1: 1, 3: 3}  # TFLite fused activation: NONE, RELU, RELU6 (engine: 0, 1, 3)


def same_pad(n_in, n_out, k, s, padding):
    if padding == 1:  # VALID
        return 0
    total = max((n_out - 1) * s + k - n_in, 0)
    return total // 2


def convert(src, dst):
    m = tfl.load(src)
    T = m["tensors"]
    const = {}  # tensor index -> float32 array (weights after DEQUANTIZE, or float32 buffers)
    for i, t in enumerate(T):
        d = tfl.tensor_data(m, i)
        if d is not None and t["type"] in ("float32", "float16"):
            const[i] = d.astype(np.float32)
    alias = {}  # RESHAPE output -> input (same memory)

    def root(i):
        while i in alias:
            i = alias[i]
        return i

    for o in m["ops"]:
        if o["name"] == "DEQUANTIZE":
            const[o["outputs"][0]] = const[o["inputs"][0]]
    ops = [o for o in m["ops"] if o["name"] != "DEQUANTIZE"]

    weights = []  # float32 chunks, concatenated at the end
    wcount = [0]

    def put(arr):
        a = np.ascontiguousarray(arr, dtype=np.float32).ravel()
        off = wcount[0]
        weights.append(a)
        wcount[0] += a.size
        return off

    def size(i):
        return int(np.prod(T[i]["shape"]))

    prog = []  # (op list with tensor indices still symbolic: ('t', index))
    for o in ops:
        n, ins, outs = o["name"], o["inputs"], o["outputs"]
        x, y = ins[0], outs[0]
        if n == "RESHAPE":
            alias[y] = x
            continue
        if n == "CONV_2D":
            p = tfl.conv_opts(o["opts"])
            assert p["dil_w"] == 1 and p["dil_h"] == 1 and p["stride_w"] == p["stride_h"]
            w = const[ins[1]]  # [cout, kh, kw, cin]
            b = const[ins[2]] if len(ins) > 2 and ins[2] >= 0 else np.zeros(w.shape[0], np.float32)
            _, ih, iw, cin = T[x]["shape"]
            _, oh, ow, cout = T[y]["shape"]
            kh, kw = w.shape[1], w.shape[2]
            s = p["stride_w"]
            act = ACT[p["act"]]
            if kh == 1 and kw == 1 and s == 1:
                prog.append([CONV1, ("t", x), ("t", y), oh * ow, cin, cout, act,
                             put(w.reshape(cout, cin).T), put(b)])
            else:
                pt = same_pad(ih, oh, kh, s, p["padding"])
                pl = same_pad(iw, ow, kw, s, p["padding"])
                prog.append([CONV, ("t", x), ("t", y), ih, iw, cin, oh, ow, cout, kh, kw, s, pt, pl, act,
                             put(w.transpose(1, 2, 3, 0)), put(b)])
        elif n == "DEPTHWISE_CONV_2D":
            p = tfl.dw_opts(o["opts"])
            assert p["mult"] == 1 and p["dil_w"] == 1 and p["stride_w"] == p["stride_h"]
            w = const[ins[1]]  # [1, kh, kw, c]
            b = const[ins[2]] if len(ins) > 2 and ins[2] >= 0 else np.zeros(w.shape[3], np.float32)
            _, ih, iw, c = T[x]["shape"]
            _, oh, ow, _ = T[y]["shape"]
            k = w.shape[1]
            assert w.shape[2] == k
            s = p["stride_w"]
            prog.append([DW, ("t", x), ("t", y), ih, iw, c, oh, ow, k, s,
                         same_pad(ih, oh, k, s, p["padding"]), same_pad(iw, ow, k, s, p["padding"]), ACT[p["act"]],
                         put(w[0]), put(b)])
        elif n == "ADD":
            p = tfl.add_opts(o["opts"])
            assert T[ins[0]]["shape"] == T[ins[1]]["shape"] == T[y]["shape"], "ADD with broadcasting"
            prog.append([ADD, ("t", ins[0]), ("t", ins[1]), ("t", y), size(y), ACT[p["act"]]])
        elif n == "PRELU":
            a = const[ins[1]].ravel()
            c = T[y]["shape"][-1]
            assert a.size == c
            prog.append([PRELU, ("t", x), ("t", y), size(y) // c, c, put(a)])
        elif n == "PAD":
            pads = tfl.tensor_data(m, ins[1]).reshape(-1, 2)
            assert (pads[:3] == 0).all() and pads[3][0] == 0, "only zero channels at the end"
            cin, cout = T[x]["shape"][-1], T[y]["shape"][-1]
            prog.append([PADC, ("t", x), ("t", y), size(y) // cout, cin, cout])
        elif n == "MAX_POOL_2D":
            p = tfl.pool_opts(o["opts"])
            _, ih, iw, c = T[x]["shape"]
            _, oh, ow, _ = T[y]["shape"]
            assert p["fw"] == 2 and p["fh"] == 2 and p["stride_w"] == 2 and ih == 2 * oh and iw == 2 * ow
            prog.append([MAXPOOL2, ("t", x), ("t", y), ih, iw, c, oh, ow])
        elif n == "RESIZE_BILINEAR":
            p = tfl.resize_opts(o["opts"])
            _, ih, iw, c = T[x]["shape"]
            _, oh, ow, _ = T[y]["shape"]
            assert oh == 2 * ih and ow == 2 * iw and p["half"] and not p["align"]
            prog.append([RESIZE2X, ("t", x), ("t", y), ih, iw, c])
        elif n == "MEAN":
            axes = tfl.tensor_data(m, ins[1]).tolist()
            assert axes == [1, 2]
            _, h, w_, c = T[x]["shape"]
            prog.append([MEAN, ("t", x), ("t", y), h * w_, c])
        elif n == "FULLY_CONNECTED":
            p = tfl.fc_opts(o["opts"])
            w = const[ins[1]]  # [cout, cin]
            b = const[ins[2]] if len(ins) > 2 and ins[2] >= 0 else np.zeros(w.shape[0], np.float32)
            prog.append([FC, ("t", x), ("t", y), w.shape[1], w.shape[0], ACT[p["act"]], put(w.T), put(b)])
        elif n == "LOGISTIC":
            prog.append([SIGMOID, ("t", x), ("t", y), size(y)])
        elif n == "CONCATENATION":
            p = tfl.concat_opts(o["opts"])
            assert p["axis"] in (1, -2) and T[y]["shape"][0] == 1
            start = 0
            for i in ins:
                prog.append([COPY, ("t", i), ("t", y, start), size(i)])
                start += size(i)
        else:
            raise SystemExit(f"unsupported op {n}")

    # memory plan: every tensor (after aliasing) gets a slot in one arena; a slot is reused once nothing reads it
    inp, outs = m["inputs"][0], [root(i) for i in m["outputs"]]
    first, last = {root(inp): -1}, {}
    for k, op in enumerate(prog):
        refs = [a for a in op if isinstance(a, tuple)]
        for idx, a in enumerate(refs):
            r = root(a[1])
            # the last tensor reference of an op is what it writes (COPY writes into a slice of its output)
            if idx == len(refs) - 1:
                first.setdefault(r, k)
            last[r] = k
    for r in outs:
        last[r] = len(prog)
    slots = []  # [offset, size, free_after]
    offset = {}
    arena = 0
    for r in sorted(first, key=lambda r: first[r]):
        need = (size(r) + 3) // 4 * 4  # 16-byte aligned starts
        best = None
        for s in slots:
            if s[2] < first[r] and s[1] >= need and (best is None or s[1] < best[1]):
                best = s
        if best is None:
            best = [arena, need, -2]
            arena += need
            slots.append(best)
        offset[r] = best[0]
        best[2] = last.get(r, first[r])

    def resolve(a):
        if isinstance(a, tuple):
            return offset[root(a[1])] + (a[2] if len(a) > 2 else 0)
        return int(a)

    ops_out = [[resolve(a) for a in op] for op in prog]
    names = {root(i): T[i]["name"] for i in m["outputs"]}
    out_info = {}
    for i in m["outputs"]:
        r = root(i)
        out_info[T[i]["name"]] = {"off": offset[r], "shape": T[i]["shape"]}
    head = {
        "input": {"off": offset[root(inp)], "shape": T[inp]["shape"][1:]},
        "outputs": out_info,
        "arena": int(arena),
        "weights": int(wcount[0]),
        "ops": ops_out,
    }
    js = json.dumps(head, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    w16 = np.concatenate(weights).astype(np.float16) if weights else np.zeros(0, np.float16)
    with open(dst, "wb") as f:
        f.write(b"FHM1" + struct.pack("<I", len(js)) + js + w16.tobytes())
    print(f"{dst}: {len(ops_out)} ops, arena {arena * 4 / 1e6:.1f} MB, weights {w16.size * 2 / 1e6:.2f} MB, "
          f"outputs {list(out_info)}")


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
