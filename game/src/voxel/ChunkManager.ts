import * as THREE from 'three';
import { CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CHUNK_COUNT, WORLD_X, WORLD_Y, WORLD_Z } from '../core/constants';
import { palette } from './palette';
import { PAD } from './greedy';
import { useBakedVertexAO } from '../core/lighting';
import type { VoxelWorld } from './VoxelWorld';
import MesherWorker from './mesher.worker?worker';

const PAD3 = PAD * PAD * PAD;
const HALF = CHUNK / 2;
const CHUNK_RADIUS = Math.sqrt(3) * HALF;

interface Job {
  chunk: number;
  cx: number;
  cy: number;
  cz: number;
}

/**
 * Owns the renderable chunk meshes and the worker pool that builds them.
 *
 * Only dirty chunks are re-meshed, jobs are dispatched nearest-first, and both
 * the padded scratch buffers and the workers themselves are pooled so a steady
 * stream of block edits never allocates.
 */
export class ChunkManager {
  readonly group = new THREE.Group();

  private readonly meshes: (THREE.Mesh | null)[] = new Array(CHUNK_COUNT).fill(null);
  private readonly material: THREE.MeshLambertMaterial;
  private readonly workers: Worker[] = [];
  private readonly busy: boolean[] = [];
  private readonly bufferPool: Uint8Array[] = [];
  private readonly queue: Job[] = [];
  private readonly queued = new Set<number>();
  /** Generation counter per chunk so stale worker results are discarded. */
  private readonly generation = new Int32Array(CHUNK_COUNT);
  private readonly inFlight = new Map<number, number>();
  private nextJobId = 1;

  private readonly focus = new THREE.Vector3();

  /** Resolvers waiting for the mesh queue to drain (see meshAll). */
  private idleResolvers: (() => void)[] = [];
  private progressCb: (() => void) | null = null;

  constructor(private readonly world: VoxelWorld, workerCount?: number) {
    this.group.name = 'voxel-chunks';
    this.group.matrixAutoUpdate = false;

    // Lambert rather than unlit: the mesher now ships albedo, a normal and an
    // occlusion byte separately, so the sun and the sky ambient do the shading
    // that used to be a constant baked per face direction.
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      fog: true,
      side: THREE.FrontSide,
    });
    useBakedVertexAO(this.material);

    const n = workerCount ?? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new MesherWorker();
      w.postMessage({ type: 'init', palette });
      w.onmessage = (ev) => this.onWorkerMessage(i, ev);
      this.workers.push(w);
      this.busy.push(false);
    }
  }

  get workerCount(): number {
    return this.workers.length;
  }

  setFocus(v: THREE.Vector3): void {
    this.focus.copy(v);
  }

  /** Drains the world's dirty set into the job queue and keeps workers fed. */
  update(): void {
    if (this.world.dirtyChunks.size > 0) {
      for (const c of this.world.dirtyChunks) {
        if (this.queued.has(c)) continue;
        const cx = c % CHUNKS_X;
        const cz = ((c / CHUNKS_X) | 0) % CHUNKS_Z;
        const cy = (c / (CHUNKS_X * CHUNKS_Z)) | 0;
        this.queue.push({ chunk: c, cx, cy, cz });
        this.queued.add(c);
        this.generation[c]++;
      }
      this.world.dirtyChunks.clear();
      this.sortQueue();
    }

    for (let i = 0; i < this.workers.length && this.queue.length > 0; i++) {
      if (this.busy[i]) continue;
      const job = this.queue.shift()!;
      this.queued.delete(job.chunk);
      this.dispatch(i, job);
    }
  }

  /** Nearest chunks first so edits under the player pop back instantly. */
  private sortQueue(): void {
    if (this.queue.length < 2) return;
    const fx = this.focus.x, fy = this.focus.y, fz = this.focus.z;
    this.queue.sort((a, b) => {
      const ax = a.cx * CHUNK + HALF - fx, ay = a.cy * CHUNK + HALF - fy, az = a.cz * CHUNK + HALF - fz;
      const bx = b.cx * CHUNK + HALF - fx, by = b.cy * CHUNK + HALF - fy, bz = b.cz * CHUNK + HALF - fz;
      return (ax * ax + ay * ay + az * az) - (bx * bx + by * by + bz * bz);
    });
  }

  private dispatch(workerIndex: number, job: Job): void {
    const padded = this.bufferPool.pop() ?? new Uint8Array(PAD3);
    this.extractPadded(job.cx, job.cy, job.cz, padded);
    const id = this.nextJobId++;
    this.inFlight.set(id, job.chunk);
    this.busy[workerIndex] = true;
    this.workers[workerIndex].postMessage(
      { type: 'mesh', id, cx: job.cx, cy: job.cy, cz: job.cz, padded },
      [padded.buffer],
    );
  }

  /** Copies a chunk plus a 1-voxel border into a flat padded buffer. */
  private extractPadded(cx: number, cy: number, cz: number, out: Uint8Array): void {
    out.fill(0);
    const blocks = this.world.blocks;
    const ox = cx * CHUNK;
    const oy = cy * CHUNK;
    const oz = cz * CHUNK;

    // Clamp the X run once; the border voxels outside the map stay air.
    const xStart = Math.max(0, ox - 1);
    const xEnd = Math.min(WORLD_X, ox + CHUNK + 1);
    const runLen = xEnd - xStart;
    if (runLen <= 0) return;
    const dstXOffset = xStart - (ox - 1);

    for (let ly = -1; ly <= CHUNK; ly++) {
      const wy = oy + ly;
      if (wy < 0 || wy >= WORLD_Y) continue;
      const dstY = (ly + 1) * PAD * PAD;
      const srcY = wy * WORLD_Z;
      for (let lz = -1; lz <= CHUNK; lz++) {
        const wz = oz + lz;
        if (wz < 0 || wz >= WORLD_Z) continue;
        const src = (srcY + wz) * WORLD_X + xStart;
        const dst = dstY + (lz + 1) * PAD + dstXOffset;
        out.set(blocks.subarray(src, src + runLen), dst);
      }
    }
  }

  private onWorkerMessage(workerIndex: number, ev: MessageEvent): void {
    this.busy[workerIndex] = false;
    const data = ev.data as {
      id: number; cx: number; cy: number; cz: number;
      positions: Float32Array; normals: Int8Array; colors: Uint8Array;
      ao: Uint8Array; indices: Uint32Array;
      padded: Uint8Array;
    };

    if (this.bufferPool.length < 8) this.bufferPool.push(data.padded);

    const chunk = this.inFlight.get(data.id);
    this.inFlight.delete(data.id);
    if (chunk === undefined) return;

    this.applyMesh(
      chunk, data.cx, data.cy, data.cz,
      data.positions, data.normals, data.colors, data.ao, data.indices,
    );

    // Keep the pipeline saturated.
    if (this.queue.length > 0 && !this.busy[workerIndex]) {
      const job = this.queue.shift()!;
      this.queued.delete(job.chunk);
      this.dispatch(workerIndex, job);
    }

    this.progressCb?.();
    this.settleIdleWaiters();
  }

  private settleIdleWaiters(): void {
    if (!this.idle || this.idleResolvers.length === 0) return;
    const waiting = this.idleResolvers;
    this.idleResolvers = [];
    this.progressCb = null;
    for (const resolve of waiting) resolve();
  }

  private applyMesh(
    chunk: number, cx: number, cy: number, cz: number,
    positions: Float32Array, normals: Int8Array, colors: Uint8Array,
    ao: Uint8Array, indices: Uint32Array,
  ): void {
    let mesh = this.meshes[chunk];

    if (indices.length === 0) {
      if (mesh) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes[chunk] = null;
      }
      return;
    }

    if (!mesh) {
      const geom = new THREE.BufferGeometry();
      mesh = new THREE.Mesh(geom, this.material);
      // Terrain both blocks the sun and takes shadows from whatever is above it.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(cx * CHUNK, cy * CHUNK, cz * CHUNK);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      // Analytic bounds — never scan the vertex buffer for this.
      geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(HALF, HALF, HALF), CHUNK_RADIUS);
      geom.boundingBox = new THREE.Box3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(CHUNK, CHUNK, CHUNK),
      );
      this.meshes[chunk] = mesh;
      this.group.add(mesh);
    }

    const geom = mesh.geometry;
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3, true));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    geom.setAttribute('ao', new THREE.BufferAttribute(ao, 1, true));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.setDrawRange(0, indices.length);
  }

  /** True once every queued remesh has landed — used for the loading screen. */
  get idle(): boolean {
    return this.queue.length === 0 && this.inFlight.size === 0 && this.world.dirtyChunks.size === 0;
  }

  get pendingCount(): number {
    return this.queue.length + this.inFlight.size + this.world.dirtyChunks.size;
  }

  /**
   * Builds the initial world mesh.
   *
   * Driven by worker-completion events rather than a polling timer: browsers
   * clamp timers hard in background tabs, which used to stall loading for
   * minutes if the player switched away mid-load.
   */
  async meshAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    this.world.markAllDirty();
    const total = CHUNK_COUNT;
    this.update();
    onProgress?.(total - this.pendingCount, total);
    if (this.idle) return;
    await new Promise<void>((resolve) => {
      this.progressCb = () => onProgress?.(total - this.pendingCount, total);
      this.idleResolvers.push(resolve);
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const m of this.meshes) if (m) m.geometry.dispose();
    this.material.dispose();
  }
}

export { CHUNKS_X, CHUNKS_Y, CHUNKS_Z };
