/** Minimal stand-in for the "obsidian" module so editor and integration code can be unit-tested outside Obsidian. */
export function setIcon(): void {}

/** Messages shown with `new Notice(..)` are collected in globalThis.__notices for assertions. */
export class Notice {
  constructor(message: string) {
    const g = globalThis as unknown as { __notices?: string[] };
    (g.__notices ??= []).push(message);
  }
}
export class TFile {
  path = "";
  extension = "";
  basename = "";
  stat = { mtime: 0, size: 0 };
}
export class App {}
export class Modal {
  titleEl = { setText() {} };
  contentEl = {};
  constructor(public app?: unknown) {}
  open() {}
  close() {}
}
export class FuzzySuggestModal<T> extends Modal {
  setPlaceholder() {}
  getItems(): T[] {
    return [];
  }
}
export class Setting {}
export class ItemView {}
export class TextFileView {}
export class PluginSettingTab {}
