import { App, PluginSettingTab, Setting, Notice, setIcon } from "obsidian";
import type TexPanePlugin from "./main";
import type { Engine } from "./types";
import { installHint } from "./core/toolchain";

export type OpenIn = "split" | "editor" | "pdf";
export type LayoutMode = "split" | "editor" | "pdf";

export interface TexPaneSettings {
  engine: Engine;
  texBinDir: string;
  autoCompile: boolean;
  compileDelayMs: number;
  buildTimeoutSec: number;
  buildFolder: string;
  copyPdfBeside: boolean;
  shellEscape: boolean;
  openIn: OpenIn;
  fontSize: number;
  softWrap: boolean;
  pdfDarkMode: boolean;
  useAccent: boolean;
  extraArgs: string;
  syntaxColours: "texpane" | "theme";
  wikilinkFootnote: boolean;
  highlightAsEmph: boolean;
  registerAuxTypes: boolean;
  showWordCount: boolean;
  /** per project (root path relative to vault): divider ratio */
  splitRatios: Record<string, number>;
}

export const DEFAULT_SETTINGS: TexPaneSettings = {
  engine: "pdflatex",
  texBinDir: "",
  autoCompile: true,
  compileDelayMs: 800,
  buildTimeoutSec: 120,
  buildFolder: ".texpane/build",
  copyPdfBeside: false,
  shellEscape: false,
  openIn: "split",
  fontSize: 14,
  softWrap: true,
  pdfDarkMode: false,
  useAccent: false,
  extraArgs: "",
  syntaxColours: "texpane",
  wikilinkFootnote: false,
  highlightAsEmph: true,
  registerAuxTypes: true,
  showWordCount: true,
  splitRatios: {},
};

export class TexPaneSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TexPanePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
    };

    new Setting(containerEl).setName("TeX toolchain").setHeading();
    this.renderToolchain(containerEl.createDiv({ cls: "tp-settings-toolchain" }));

    new Setting(containerEl)
      .setName("TeX binaries folder")
      .setDesc("Leave empty to auto-detect (PATH, then MacTeX / TeX Live / MiKTeX locations).")
      .addText((t) =>
        t.setPlaceholder("auto-detect").setValue(s.texBinDir).onChange(async (v) => {
          s.texBinDir = v.trim();
          await save();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Re-check").onClick(async () => {
          await this.plugin.detectToolchain();
          this.display();
        }),
      );

    new Setting(containerEl).setName("Compiling").setHeading();
    new Setting(containerEl)
      .setName("Default engine")
      .setDesc("Overridden per file by `% !TEX program = xelatex`.")
      .addDropdown((d) =>
        d.addOptions({ pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" }).setValue(s.engine).onChange(async (v) => {
          s.engine = v as Engine;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Auto-compile while typing")
      .setDesc("Off: compile only on Mod+S or Mod+Enter.")
      .addToggle((t) =>
        t.setValue(s.autoCompile).onChange(async (v) => {
          s.autoCompile = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Compile delay")
      .setDesc("Milliseconds of quiet before an automatic build (300 to 5000).")
      .addSlider((sl) =>
        sl.setLimits(300, 5000, 100).setValue(s.compileDelayMs).setDynamicTooltip().onChange(async (v) => {
          s.compileDelayMs = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Build timeout")
      .setDesc("Seconds before a running build is killed.")
      .addText((t) =>
        t.setValue(String(s.buildTimeoutSec)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 5) {
            s.buildTimeoutSec = n;
            await save();
          }
        }),
      );
    new Setting(containerEl)
      .setName("Build folder")
      .setDesc("Relative to the root file's folder. Dot-folders are hidden from the file explorer.")
      .addText((t) =>
        t.setValue(s.buildFolder).onChange(async (v) => {
          if (v.trim() && !v.includes("..")) {
            s.buildFolder = v.trim();
            await save();
          }
        }),
      );
    new Setting(containerEl)
      .setName("Copy PDF beside root file")
      .setDesc("After each successful build, also write main.pdf next to main.tex.")
      .addToggle((t) =>
        t.setValue(s.copyPdfBeside).onChange(async (v) => {
          s.copyPdfBeside = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Shell escape")
      .setDesc("Adds -shell-escape (needed for minted). Warning: documents can then run arbitrary commands on your computer. Only enable for documents you trust.")
      .addToggle((t) =>
        t.setValue(s.shellEscape).onChange(async (v) => {
          s.shellEscape = v;
          await save();
          if (v) new Notice("TeXPane: shell escape enabled. Documents can now run commands.", 8000);
        }),
      );
    new Setting(containerEl)
      .setName("Extra latexmk arguments")
      .setDesc("Split on spaces (quotes allowed). Never passed through a shell.")
      .addText((t) =>
        t.setPlaceholder("-bibtex").setValue(s.extraArgs).onChange(async (v) => {
          s.extraArgs = v;
          await save();
        }),
      );

    new Setting(containerEl).setName("Editor and layout").setHeading();
    new Setting(containerEl)
      .setName("Open .tex files in")
      .addDropdown((d) =>
        d.addOptions({ split: "Split (editor and PDF)", editor: "Editor only", pdf: "PDF only" }).setValue(s.openIn).onChange(async (v) => {
          s.openIn = v as OpenIn;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Editor font size")
      .addSlider((sl) =>
        sl.setLimits(10, 28, 1).setValue(s.fontSize).setDynamicTooltip().onChange(async (v) => {
          s.fontSize = v;
          await save();
          this.plugin.refreshViews();
        }),
      );
    new Setting(containerEl)
      .setName("Soft wrap")
      .addToggle((t) =>
        t.setValue(s.softWrap).onChange(async (v) => {
          s.softWrap = v;
          await save();
          this.plugin.refreshViews();
        }),
      );
    new Setting(containerEl)
      .setName("Syntax colours")
      .setDesc("TeXPane (Parchment & Ink) or follow the Obsidian theme's code colours.")
      .addDropdown((d) =>
        d.addOptions({ texpane: "TeXPane (Parchment & Ink)", theme: "Follow theme" }).setValue(s.syntaxColours).onChange(async (v) => {
          s.syntaxColours = v as "texpane" | "theme";
          await save();
          this.plugin.refreshViews();
        }),
      );
    new Setting(containerEl)
      .setName("Use Obsidian accent colour")
      .setDesc("Use the accent colour for the caret and active line marker.")
      .addToggle((t) =>
        t.setValue(s.useAccent).onChange(async (v) => {
          s.useAccent = v;
          await save();
          this.plugin.refreshViews();
        }),
      );
    new Setting(containerEl)
      .setName("PDF dark mode")
      .setDesc("Invert PDF colours for night writing.")
      .addToggle((t) =>
        t.setValue(s.pdfDarkMode).onChange(async (v) => {
          s.pdfDarkMode = v;
          await save();
          this.plugin.refreshViews();
        }),
      );
    new Setting(containerEl)
      .setName("Show word count")
      .setDesc("Uses texcount when installed; hidden otherwise.")
      .addToggle((t) =>
        t.setValue(s.showWordCount).onChange(async (v) => {
          s.showWordCount = v;
          await save();
          this.plugin.updateStatusBar();
        }),
      );

    new Setting(containerEl).setName("Obsidian note embeds").setHeading();
    new Setting(containerEl)
      .setName("Wikilinks as footnotes")
      .setDesc("Append a footnote with the note name after each [[wikilink]] in embedded notes.")
      .addToggle((t) =>
        t.setValue(s.wikilinkFootnote).onChange(async (v) => {
          s.wikilinkFootnote = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Highlights as emphasis")
      .setDesc("Render ==highlighted== text as \\emph; off keeps it plain.")
      .addToggle((t) =>
        t.setValue(s.highlightAsEmph).onChange(async (v) => {
          s.highlightAsEmph = v;
          await save();
        }),
      );

    new Setting(containerEl).setName("File types").setHeading();
    new Setting(containerEl)
      .setName("Open .bib, .sty and .cls in TeXPane")
      .setDesc("Disable if another plugin owns these extensions. Takes effect after restarting Obsidian.")
      .addToggle((t) =>
        t.setValue(s.registerAuxTypes).onChange(async (v) => {
          s.registerAuxTypes = v;
          await save();
          new Notice("TeXPane: restart Obsidian for this change to take effect.");
        }),
      );
  }

  private renderToolchain(el: HTMLElement) {
    el.empty();
    const t = this.plugin.toolchain;
    if (!t) {
      el.createEl("p", { text: "Detecting TeX tools…", cls: "setting-item-description" });
      void this.plugin.ensureToolchain().then(() => {
        if (el.isConnected) this.renderToolchain(el);
      }, () => undefined);
      return;
    }
    const rows: Array<[string, string | null, boolean]> = [
      ["latexmk", t.latexmk ? t.latexmk.version : null, true],
      ["synctex", t.synctex ? t.synctex.version : null, true],
      ["pdflatex", t.engines.pdflatex?.version ?? null, false],
      ["xelatex", t.engines.xelatex?.version ?? null, false],
      ["lualatex", t.engines.lualatex?.version ?? null, false],
      ["bibtex", t.bibtex?.version ?? null, false],
      ["biber", t.biber?.version ?? null, false],
      ["texcount", t.texcount?.version ?? null, false],
    ];
    const list = el.createDiv({ cls: "tp-tool-list" });
    for (const [name, version, required] of rows) {
      const row = list.createDiv({ cls: "tp-tool-row" });
      const ic = row.createSpan({ cls: "tp-tool-icon" });
      setIcon(ic, version ? "check" : required ? "x" : "minus");
      ic.addClass(version ? "is-ok" : required ? "is-missing" : "is-optional");
      row.createSpan({ text: name, cls: "tp-tool-name" });
      row.createSpan({ text: version ?? (required ? "not found" : "not installed"), cls: "tp-tool-version" });
    }
    if (t.binDir) el.createEl("p", { text: `Found in ${t.binDir}`, cls: "setting-item-description" });
    if (!t.found) {
      const hint = installHint(t.platform as NodeJS.Platform);
      const card = el.createDiv({ cls: "tp-setup-card" });
      card.createEl("strong", { text: "LaTeX was not found" });
      card.createEl("p", { text: `${hint.title}: ${hint.url}` });
      const ol = card.createEl("ol");
      hint.steps.forEach((x) => ol.createEl("li", { text: x }));
    }
  }
}
