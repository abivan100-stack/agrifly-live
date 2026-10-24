// Draws one band of rows of the drone camera view off the main thread, so several CPU cores share the work
// and the picture can be sharper without slowing the page. The drawing code itself is in field-view.js.
importScripts('field-view.js');

const renderer = self.FieldView.createRenderer();

self.onmessage = (e) => {
  const { i, cam, w, h, y0, y1, buf } = e.data;
  renderer.renderRows(cam, w, h, y0, y1, new Uint32Array(buf));
  self.postMessage({ i, w, h, y0, buf }, [buf]); // hand the buffer back without copying it
};
