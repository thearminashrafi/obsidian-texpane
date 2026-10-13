import { App, FuzzySuggestModal, Modal, Setting, TFile } from "obsidian";

export class EmbedNoteModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder("Embed a note as \\obsidian{…}");
  }
  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
  }
  getItemText(f: TFile): string {
    return f.path.replace(/\.md$/i, "");
  }
  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}

export class PromptModal extends Modal {
  private value: string;
  constructor(app: App, private title: string, private placeholder: string, initial: string, private cta: string, private onSubmit: (v: string) => void) {
    super(app);
    this.value = initial;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    // Modal.setTitle is missing on older 1.x builds; minAppVersion is 1.8.0
    if (typeof (this as Partial<Modal>).setTitle === "function") this.setTitle(this.title);
    else this.titleEl.setText(this.title);
    let input: HTMLInputElement | null = null;
    new Setting(contentEl).addText((t) => {
      input = t.inputEl;
      t.setPlaceholder(this.placeholder).setValue(this.value).onChange((v) => (this.value = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
      t.inputEl.style.width = "100%";
    });
    new Setting(contentEl).addButton((b) => b.setButtonText(this.cta).setCta().onClick(() => this.submit()));
    window.setTimeout(() => {
      input?.focus();
      input?.select();
    }, 10);
  }
  private submit() {
    const v = this.value.trim();
    if (!v) return;
    this.close();
    this.onSubmit(v);
  }
  onClose() {
    this.contentEl.empty();
  }
}
