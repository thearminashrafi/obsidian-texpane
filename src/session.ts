import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CompileQueue, type QueueState } from "./core/compileQueue";
import { runBuild } from "./core/buildPipeline";
import { splitArgs } from "./core/latexmkRunner";
import { ProjectIndex } from "./core/indexers";
import { buildEnv, defaultExec } from "./core/toolchain";
import type { BuildRequest, BuildResult, ProjectInfo } from "./types";
import type TexPanePlugin from "./main";

export type SessionEvent = { type: "state"; state: QueueState } | { type: "result"; result: BuildResult } | { type: "words"; words: number | null };

/** One compile queue + last result per project root; shared by all views of the project. */
export class ProjectSession {
  readonly listeners = new Set<(e: SessionEvent) => void>();
  last: BuildResult | null = null;
  state: QueueState = "idle";
  readonly queue: CompileQueue<BuildResult>;
  readonly index: ProjectIndex;
  embeddedNotes = new Set<string>();
  words: number | null = null;
  /** Resolves the project info fresh before every build (magic comments may change) */
  resolver: (() => Promise<ProjectInfo>) | null = null;

  constructor(private plugin: TexPanePlugin, public project: ProjectInfo) {
    this.index = new ProjectIndex({
      readFile: async (p) => {
        try {
          return await fsp.readFile(p, "utf8");
        } catch {
          return null;
        }
      },
      listBibFiles: async (dir) => {
        try {
          return (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".bib")).map((f) => path.join(dir, f));
        } catch {
          return [];
        }
      },
    });
    this.queue = new CompileQueue<BuildResult>({
      run: (job) => this.run(job.force, job.signal),
      delayMs: () => this.plugin.settings.compileDelayMs,
      onState: (s) => {
        this.state = s;
        this.emit({ type: "state", state: s });
      },
    });
    void this.index.build(project.rootAbsPath).catch(() => undefined);
  }

  private emit(e: SessionEvent) {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error("[TeXPane] listener failed", err);
      }
    }
  }

  schedule() {
    if (this.plugin.settings.autoCompile) this.queue.schedule();
  }
  compileNow(): Promise<BuildResult> {
    return this.queue.compileNow();
  }
  cancel() {
    this.queue.cancel();
  }
  dispose() {
    this.queue.dispose();
    this.listeners.clear();
  }

  private async run(force: boolean, signal: AbortSignal): Promise<BuildResult> {
    const s = this.plugin.settings;
    await this.plugin.saveDirtyViews();
    const project = this.resolver ? await this.resolver() : this.project;
    this.project = project;
    const tc = this.plugin.toolchain;
    const req: BuildRequest = {
      project,
      shellEscape: s.shellEscape,
      extraArgs: splitArgs(s.extraArgs),
      timeoutMs: s.buildTimeoutSec * 1000,
      texBinDir: tc?.binDir ?? null,
      force,
      vaultBase: this.plugin.notes.basePath(),
    };
    const result = await runBuild(req, {
      latexmkPath: tc?.latexmk?.path ?? null,
      env: buildEnv({ binDir: tc?.binDir ?? null }, process.env),
      notes: this.plugin.notes,
      wikilinkFootnote: s.wikilinkFootnote,
      highlightEmph: s.highlightAsEmph,
      signal,
      onEmbedGraph: (g) => {
        this.embeddedNotes = new Set(g.flatMap((e) => e.notePaths));
        this.plugin.registerEmbedGraph(this);
      },
    });
    this.last = result;
    void this.index.build(project.rootAbsPath).catch(() => undefined);
    if (result.pdfPath && result.pdfUpdated && s.copyPdfBeside) {
      try {
        await fsp.copyFile(result.pdfPath, path.join(project.cwd, path.basename(project.rootAbsPath).replace(/\.tex$/i, "") + ".pdf"));
      } catch (e) {
        console.warn("[TeXPane] could not copy PDF", e);
      }
    }
    this.emit({ type: "result", result });
    if (s.showWordCount && tc?.texcount && result.pdfUpdated) void this.countWords(project);
    return result;
  }

  private async countWords(project: ProjectInfo) {
    const tc = this.plugin.toolchain;
    if (!tc?.texcount) return;
    try {
      const r = await defaultExec(tc.texcount.path, ["-1", "-sum", "-inc", project.rootAbsPath], { env: buildEnv({ binDir: tc.binDir }, process.env), cwd: project.cwd, timeoutMs: 8000 });
      const m = /(\d+)/.exec(r.stdout.trim().split("\n")[0] ?? "");
      this.words = m ? Number(m[1]) : null;
    } catch {
      this.words = null;
    }
    this.emit({ type: "words", words: this.words });
  }
}
