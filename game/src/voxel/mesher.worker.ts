/// <reference lib="webworker" />
import { meshChunk } from './greedy';

let palette: Uint8Array = new Uint8Array(256 * 3);

export interface MeshRequest {
  type: 'mesh';
  id: number;
  cx: number;
  cy: number;
  cz: number;
  padded: Uint8Array;
}

export interface InitRequest {
  type: 'init';
  palette: Uint8Array<ArrayBufferLike>;
}

self.onmessage = (ev: MessageEvent<MeshRequest | InitRequest>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    palette = msg.palette as Uint8Array;
    return;
  }

  const { id, cx, cy, cz, padded } = msg;
  const result = meshChunk(padded, palette);

  // Hand the padded scratch buffer back so the main thread can pool it.
  (self as unknown as Worker).postMessage(
    {
      type: 'mesh',
      id, cx, cy, cz,
      positions: result.positions,
      normals: result.normals,
      colors: result.colors,
      ao: result.ao,
      indices: result.indices,
      padded,
    },
    [
      result.positions.buffer, result.normals.buffer, result.colors.buffer,
      result.ao.buffer, result.indices.buffer, padded.buffer,
    ],
  );
};
