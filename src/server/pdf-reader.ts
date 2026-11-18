import { Worker } from 'node:worker_threads';
import type { Annotation } from '../shared.ts';
import type { AnnotationPlacement } from './annotation-placement.ts';
import type { Located, MarkRequest } from './note-location.ts';
import type { NoteSections, SectionHeading } from './note-sections.ts';
import type { CompiledPaper } from './writer/build-map.ts';
import { ENGINE } from './paths.ts';

interface SectionAssignment { sections: string[]; context?: string[] }
interface SectionDocument {
  headings: Promise<SectionHeading[]>;
  notes: Map<string, { mark: string; assignment: Promise<SectionAssignment> }>;
}

/** Reads notes' places on manuscript PDFs in a worker thread. Opening a long
 *  paper's PDF, reading a page's text and rendering pages to compare them
 *  takes hundreds of milliseconds each, which on the server's event loop
 *  would hold up every other request, also while builds are running. The
 *  worker ends when it has been idle for a while, which frees the memory of
 *  the PDFs it read. */
export class PdfReader {
  private reader: PdfReadWorker;
  private sectionReader: PdfReadWorker;
  private stopped = false;
  // Retain only plain outline/assignment data when the PDF worker goes idle.
  // Twenty recent builds bounds history, matching other manuscript caches.
  private sectionDocuments = new Map<string, SectionDocument>();
  constructor(idleMs = 30000) {
    this.reader = new PdfReadWorker(idleMs);
    // Even the first trace/outline read can be expensive on a long paper.
    // Section analysis must never queue in front of an interactive location.
    this.sectionReader = new PdfReadWorker(idleMs);
  }

  /** The text under a marked region of a PDF page and the source lines it
   *  came from; null when the page does not exist. */
  locate(request: MarkRequest): Promise<Located | null> { return this.call('locate', request); }
  /** Notes from earlier PDFs placed on the current one, in order; null for
   *  a note whose place is not proven. */
  place(current: string, notes: { note: Annotation; previous: string }[]): Promise<(AnnotationPlacement | null)[]> {
    return notes.length ? this.call('place', { current, notes }) : Promise.resolve([]);
  }

  async sections(compiled: CompiledPaper, key: string, notes: Annotation[]): Promise<NoteSections> {
    if (this.stopped) throw new Error('The server is shutting down.');
    const identity = JSON.stringify([compiled.pdf, compiled.root, compiled.sourceDir, key]);
    let document = this.sectionDocuments.get(identity);
    if (!document) {
      document = { headings: this.call<SectionHeading[]>('sectionHeadings', compiled), notes: new Map() };
      const created = document;
      void document.headings.catch(() => { if (this.sectionDocuments.get(identity) === created) this.sectionDocuments.delete(identity); });
    }
    this.sectionDocuments.delete(identity);
    this.sectionDocuments.set(identity, document);
    if (this.sectionDocuments.size > 20) this.sectionDocuments.delete(this.sectionDocuments.keys().next().value!);
    const headings = await document.headings;
    // Working-source lines, comment text, colour and selection do not change
    // where a mark sits in the compiled PDF. Only geometry invalidates it.
    const mark = (note: Annotation) => JSON.stringify([note.page, note.rects?.length ? note.rects : [note.rect]]);
    const fresh = headings.length ? notes.filter(note => note.key === key && document.notes.get(note.id)?.mark !== mark(note)) : [];
    if (fresh.length) {
      const pending = this.call<NoteSections>('sectionNotes', { compiled, key, notes: fresh, headings }).then(result => {
        const assignments = new Map<string, SectionAssignment>();
        for (const note of fresh) assignments.set(note.id, { sections: [], context: result.contexts[note.id] });
        for (const section of result.sections) for (const id of section.notes) assignments.get(id)!.sections.push(section.id);
        return assignments;
      });
      for (const note of fresh) {
        const entry = { mark: mark(note), assignment: pending.then(assignments => assignments.get(note.id)!) };
        document.notes.set(note.id, entry);
        void entry.assignment.catch(() => { if (document.notes.get(note.id) === entry) document.notes.delete(note.id); });
      }
    }
    const assignments = await Promise.all(notes.map(note => note.key === key ? document.notes.get(note.id)?.assignment : undefined));
    const sections = headings.map(({ id, title, level }) => ({ id, title, level, notes: [] as string[] }));
    const byId = new Map(sections.map(section => [section.id, section]));
    const contexts: NoteSections['contexts'] = {};
    let unplaced = 0;
    notes.forEach((note, index) => {
      const assignment = assignments[index];
      if (!assignment?.sections.length) { unplaced++; return; }
      for (const id of assignment.sections) byId.get(id)!.notes.push(note.id);
      if (assignment.context) contexts[note.id] = assignment.context;
    });
    return { sections, contexts, unplaced };
  }

  private call<T>(op: string, args: unknown): Promise<T> {
    return (op === 'sectionHeadings' || op === 'sectionNotes' ? this.sectionReader : this.reader).call<T>(op, args);
  }
  async stop() {
    this.stopped = true;
    this.sectionDocuments.clear();
    await Promise.all([this.reader.stop(), this.sectionReader.stop()]);
  }
}

/** Each lane starts lazily and releases its native PDF memory while idle. */
class PdfReadWorker {
  private worker?: Worker;
  private jobs = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private counter = 0;
  private idle?: NodeJS.Timeout;
  private stopped = false;
  constructor(private idleMs: number) {}

  call<T>(op: string, args: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('The server is shutting down.'));
    clearTimeout(this.idle);
    const worker = this.worker ??= this.start(), id = ++this.counter;
    worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      worker.postMessage({ id, op, args });
    });
  }
  private start() {
    const worker = new Worker(new URL('./pdf-reader-worker.mjs', import.meta.url), {
      // Do not inherit watch/test/inspect flags or depend on a parent's loader.
      execArgv: [], workerData: { engine: ENGINE },
    });
    worker.on('message', ({ id, value, error }: { id: number; value?: unknown; error?: string }) => {
      const job = this.jobs.get(id);
      if (!job) return;
      this.jobs.delete(id);
      if (error !== undefined) job.reject(new Error(error)); else job.resolve(value);
      if (!this.jobs.size) this.rest(worker);
    });
    worker.on('error', error => this.lost(worker, error));
    worker.on('exit', code => this.lost(worker, new Error(`PDF reading stopped before finishing (exit ${code}).`)));
    return worker;
  }
  // Nothing waits for an idle worker: it does not keep the process running,
  // and it ends after a while.
  private rest(worker: Worker) {
    worker.unref();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.worker !== worker || this.jobs.size) return;
      this.worker = undefined;
      void worker.terminate();
    }, this.idleMs);
    this.idle.unref();
  }
  private lost(worker: Worker, error: Error) {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.idle);
    const worker = this.worker;
    if (worker) this.lost(worker, new Error('The server is shutting down.'));
    await worker?.terminate();
  }
}
