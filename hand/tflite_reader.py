"""Minimal TFLite flatbuffer reader (schema v3) on the flatbuffers runtime: enough to convert the hand models."""
import flatbuffers
from flatbuffers.table import Table
import numpy as np

def _tab(buf, pos):
    return Table(buf, pos)

def _off(t, field):  # vtable offset for field index
    return t.Offset(4 + 2 * field)

def _int(t, field, kind, default=0):
    o = _off(t, field)
    if not o: return default
    return t.Get(kind, o + t.Pos)

def _str(t, field):
    o = _off(t, field)
    if not o: return None
    return t.String(o + t.Pos).decode()

def _vec_len(t, field):
    o = _off(t, field)
    return t.VectorLen(o) if o else 0

def _vec_tables(t, field):
    o = _off(t, field)
    if not o: return []
    n = t.VectorLen(o); start = t.Vector(o)
    return [_tab(t.Bytes, t.Indirect(start + 4 * i)) for i in range(n)]

def _vec_scalars(t, field, kind, size):
    o = _off(t, field)
    if not o: return []
    n = t.VectorLen(o); start = t.Vector(o)
    return [t.Get(kind, start + size * i) for i in range(n)]

def _subtable(t, field):
    o = _off(t, field)
    if not o: return None
    return _tab(t.Bytes, t.Indirect(o + t.Pos))

N = flatbuffers.number_types
TYPES = {0: "float32", 1: "float16", 2: "int32", 3: "uint8", 4: "int64", 6: "bool", 9: "int8"}
OPS = {0:"ADD",1:"AVERAGE_POOL_2D",2:"CONCATENATION",3:"CONV_2D",4:"DEPTHWISE_CONV_2D",6:"DEQUANTIZE",9:"FULLY_CONNECTED",
       14:"LOGISTIC",17:"MAX_POOL_2D",18:"MUL",19:"RELU",21:"RELU6",22:"RESHAPE",23:"RESIZE_BILINEAR",34:"PAD",40:"MEAN",
       54:"PRELU",41:"SUB",28:"TANH",25:"SOFTMAX",97:"RESIZE_NEAREST_NEIGHBOR",60:"PADV2",77:"MIRROR_PAD", 39:"TRANSPOSE",
       67:"TRANSPOSE_CONV", 74:"SQUARED_DIFFERENCE", 76:"HARD_SWISH", 83:"RSQRT"}

def load(path):
    buf = bytearray(open(path, "rb").read())
    root = _tab(buf, flatbuffers.encode.Get(flatbuffers.packer.uoffset, buf, 0))
    opcodes = []
    for oc in _vec_tables(root, 1):
        dep = _int(oc, 0, N.Int8Flags, 0)
        bc = _int(oc, 3, N.Int32Flags, 0)
        code = max(dep, bc)
        opcodes.append((code, _str(oc, 1)))
    buffers = []
    for b in _vec_tables(root, 4):
        o = _off(b, 0)
        if o:
            n = b.VectorLen(o); s = b.Vector(o)
            buffers.append(bytes(buf[s:s + n]))
        else:
            buffers.append(b"")
    sg = _vec_tables(root, 2)[0]
    tensors = []
    for t in _vec_tables(sg, 0):
        shape = _vec_scalars(t, 0, N.Int32Flags, 4)
        ttype = _int(t, 1, N.Int8Flags, 0)
        bidx = _int(t, 2, N.Uint32Flags, 0)
        name = _str(t, 3)
        tensors.append(dict(shape=shape, type=TYPES.get(ttype, ttype), buffer=bidx, name=name))
    ins = _vec_scalars(sg, 1, N.Int32Flags, 4); outs = _vec_scalars(sg, 2, N.Int32Flags, 4)
    ops = []
    for op in _vec_tables(sg, 3):
        oi = _int(op, 0, N.Uint32Flags, 0)
        code, custom = opcodes[oi]
        oin = _vec_scalars(op, 1, N.Int32Flags, 4); oout = _vec_scalars(op, 2, N.Int32Flags, 4)
        opt_type = _int(op, 3, N.Uint8Flags, 0)
        opts = _subtable(op, 4)
        ops.append(dict(code=code, name=OPS.get(code, f"OP{code}") if not custom else custom, inputs=oin, outputs=oout, opt_type=opt_type, opts=opts))
    return dict(tensors=tensors, buffers=buffers, inputs=ins, outputs=outs, ops=ops)

def tensor_data(m, i):
    t = m["tensors"][i]; b = m["buffers"][t["buffer"]]
    if not b: return None
    dt = {"float32": np.float32, "float16": np.float16, "int32": np.int32, "int8": np.int8, "uint8": np.uint8, "int64": np.int64}[t["type"]]
    return np.frombuffer(b, dtype=dt).reshape(t["shape"]) if t["shape"] else np.frombuffer(b, dtype=dt)

# option readers
def conv_opts(o):   # Conv2DOptions
    return dict(padding=_int(o,0,N.Int8Flags), stride_w=_int(o,1,N.Int32Flags), stride_h=_int(o,2,N.Int32Flags),
                act=_int(o,3,N.Int8Flags), dil_w=_int(o,4,N.Int32Flags,1), dil_h=_int(o,5,N.Int32Flags,1))
def dw_opts(o):
    return dict(padding=_int(o,0,N.Int8Flags), stride_w=_int(o,1,N.Int32Flags), stride_h=_int(o,2,N.Int32Flags),
                mult=_int(o,3,N.Int32Flags), act=_int(o,4,N.Int8Flags), dil_w=_int(o,5,N.Int32Flags,1), dil_h=_int(o,6,N.Int32Flags,1))
def pool_opts(o):
    return dict(padding=_int(o,0,N.Int8Flags), stride_w=_int(o,1,N.Int32Flags), stride_h=_int(o,2,N.Int32Flags),
                fw=_int(o,3,N.Int32Flags), fh=_int(o,4,N.Int32Flags), act=_int(o,5,N.Int8Flags))
def add_opts(o): return dict(act=_int(o,0,N.Int8Flags)) if o else dict(act=0)
def concat_opts(o): return dict(axis=_int(o,0,N.Int32Flags), act=_int(o,1,N.Int8Flags))
def fc_opts(o): return dict(act=_int(o,0,N.Int8Flags), wfmt=_int(o,1,N.Int8Flags), keep=_int(o,2,N.BoolFlags,False)) if o else dict(act=0)
def resize_opts(o): return dict(align=_int(o,2,N.BoolFlags,False), half=_int(o,3,N.BoolFlags,False)) if o else dict(align=False, half=False)
def reshape_opts(o): return dict(shape=_vec_scalars(o,0,N.Int32Flags,4)) if o else {}
