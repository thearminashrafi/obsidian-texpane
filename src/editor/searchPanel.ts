import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from "@codemirror/search";
import { setIcon } from "obsidian";

const MAX_COUNT = 500;

/** Find/replace as a small floating card (Obsidian look), instead of CodeMirror's default bar. */
export function createSearchPanel(view: EditorView): Panel {
  const q0 = getSearchQuery(view.state);
  let caseSensitive = q0.caseSensitive;
  let regexp = q0.regexp;
  let wholeWord = q0.wholeWord;
  let showReplace = !!q0.replace;

  const dom = document.createElement("div");
  dom.className = "tp-search";
  dom.addEventListener("keydown", (e) => {
    if (runScopeHandlers(view, e, "search-panel")) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === "Enter" && e.target === findInput) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.key === "Enter" && e.target === replaceInput) {
      e.preventDefault();
      replaceNext(view);
    }
  });

  const iconBtn = (icon: string, label: string, onClick: () => void, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `tp-search-btn ${cls}`.trim();
    b.setAttribute("aria-label", label);
    b.title = label;
    setIcon(b, icon);
    b.addEventListener("click", onClick);
    return b;
  };
  const toggleBtn = (text: string, label: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tp-search-btn tp-search-toggle";
    b.textContent = text;
    b.title = label;
    b.setAttribute("aria-label", label);
    const sync = () => b.classList.toggle("is-on", get());
    b.addEventListener("click", () => {
      set(!get());
      sync();
      commit();
    });
    sync();
    return b;
  };
  const input = (placeholder: string, value: string) => {
    const i = document.createElement("input");
    i.type = "text";
    i.className = "tp-search-input";
    i.placeholder = placeholder;
    i.value = value;
    i.spellcheck = false;
    i.setAttribute("autocomplete", "off");
    i.setAttribute("main-field", placeholder === "Find" ? "true" : "false");
    return i;
  };

  const findInput = input("Find", q0.search);
  const replaceInput = input("Replace", q0.replace);
  const count = document.createElement("span");
  count.className = "tp-search-count";

  const expand = iconBtn("chevron-right", "Toggle replace", () => {
    showReplace = !showReplace;
    syncReplace();
  }, "tp-search-expand");
  const syncReplace = () => {
    dom.classList.toggle("has-replace", showReplace);
    expand.classList.toggle("is-open", showReplace);
  };

  const row1 = document.createElement("div");
  row1.className = "tp-search-row";
  const fieldWrap = document.createElement("div");
  fieldWrap.className = "tp-search-field";
  fieldWrap.append(
    findInput,
    toggleBtn("Aa", "Match case", () => caseSensitive, (v) => (caseSensitive = v)),
    toggleBtn(".*", "Regular expression", () => regexp, (v) => (regexp = v)),
    toggleBtn("ab", "Whole word", () => wholeWord, (v) => (wholeWord = v)),
  );
  row1.append(
    expand,
    fieldWrap,
    count,
    iconBtn("arrow-up", "Previous match (⇧⌘G)", () => findPrevious(view)),
    iconBtn("arrow-down", "Next match (⌘G)", () => findNext(view)),
    iconBtn("x", "Close (Esc)", () => {
      closeSearchPanel(view);
      view.focus();
    }),
  );

  const row2 = document.createElement("div");
  row2.className = "tp-search-row tp-search-replace-row";
  const replaceWrap = document.createElement("div");
  replaceWrap.className = "tp-search-field";
  replaceWrap.append(replaceInput);
  const mk = (text: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tp-search-text-btn";
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  };
  row2.append(replaceWrap, mk("Replace", () => replaceNext(view)), mk("All", () => replaceAll(view)));

  dom.append(row1, row2);
  syncReplace();

  function commit() {
    const q = new SearchQuery({ search: findInput.value, caseSensitive, regexp, wholeWord, replace: replaceInput.value });
    const cur = getSearchQuery(view.state);
    if (!q.eq(cur)) view.dispatch({ effects: setSearchQuery.of(q) });
    else updateCount();
  }
  findInput.addEventListener("input", commit);
  replaceInput.addEventListener("input", commit);

  function updateCount() {
    const q = getSearchQuery(view.state);
    findInput.classList.toggle("is-invalid", !!q.search && !q.valid);
    if (!q.search || !q.valid) {
      count.textContent = "";
      return;
    }
    const sel = view.state.selection.main;
    let total = 0;
    let idx = 0;
    const cur = q.getCursor(view.state);
    for (let r = cur.next(); !r.done; r = cur.next()) {
      total++;
      if (total > MAX_COUNT) break;
      if (r.value.from === sel.from && r.value.to === sel.to) idx = total;
    }
    count.textContent = total === 0 ? "No results" : total > MAX_COUNT ? `${MAX_COUNT}+` : idx ? `${idx} of ${total}` : `${total} found`;
    count.classList.toggle("is-empty", total === 0);
  }

  return {
    dom,
    top: true,
    mount() {
      findInput.focus();
      findInput.select();
      updateCount();
    },
    update(u: ViewUpdate) {
      for (const tr of u.transactions) {
        for (const ef of tr.effects) {
          if (ef.is(setSearchQuery) && !ef.value.eq(new SearchQuery({ search: findInput.value, caseSensitive, regexp, wholeWord, replace: replaceInput.value }))) {
            const q = ef.value;
            findInput.value = q.search;
            replaceInput.value = q.replace;
            caseSensitive = q.caseSensitive;
            regexp = q.regexp;
            wholeWord = q.wholeWord;
            dom.querySelectorAll<HTMLElement>(".tp-search-toggle").forEach((b, i) => b.classList.toggle("is-on", [caseSensitive, regexp, wholeWord][i]));
          }
        }
      }
      if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))) updateCount();
    },
  };
}
