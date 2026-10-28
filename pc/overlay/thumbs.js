'use strict';
/* Thumbnails for the cards of files sent to the phone, on Linux (which has no system thumbnails to ask for): a photo is
   decoded and scaled down here, in a worker, so neither Flick's main process nor the overlay's animation waits on it.
   One at a time, in the order asked: the first card's picture is the one waited for first. */
let q = Promise.resolve();
self.onmessage = (ev) => { q = q.then(() => thumb(ev.data || {})); };

async function thumb(m) {
  let r = { id: m.id };
  try {
    const bmp = await createImageBitmap(new Blob([m.data]));
    const k = Math.min(1, (m.max || 360) / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const cv = new OffscreenCanvas(w, h);
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    r = { id: m.id, url: new FileReaderSync().readAsDataURL(blob), w, h };
  } catch (e) { /* not a picture this can read: no thumbnail */ }
  self.postMessage(r);
}
