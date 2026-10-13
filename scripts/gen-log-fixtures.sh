#!/usr/bin/env bash
# Generates real TeX logs by compiling deliberately broken documents the way the plugin does.
# Output: test/fixtures/logs/<name>.{tex,log,blg}  (+ <name>.engine)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/test/fixtures/logs"
WORK="$(mktemp -d)"
mkdir -p "$OUT"
export max_print_line=10000
run() { # name engine  (main.tex + extra files already in $WORK/$name)
  local name="$1" engine="${2:-pdflatex}"; local d="$WORK/$name"
  local flag="-pdf"; [ "$engine" = xelatex ] && flag="-pdfxe"; [ "$engine" = lualatex ] && flag="-pdflua"
  ( cd "$d" && latexmk $flag -interaction=nonstopmode -file-line-error -synctex=1 -outdir=.texpane/build main.tex >/dev/null 2>&1 )
  cp "$d/main.tex" "$OUT/$name.tex"
  cp "$d/.texpane/build/main.log" "$OUT/$name.log"
  [ -f "$d/.texpane/build/main.blg" ] && cp "$d/.texpane/build/main.blg" "$OUT/$name.blg"
  echo "$engine" > "$OUT/$name.engine"
}
mk() { mkdir -p "$WORK/$1"; cat > "$WORK/$1/main.tex"; }

mk clean <<'T'
\documentclass{article}
\begin{document}
Hello, world.
\end{document}
T
mk undefined-command <<'T'
\documentclass{article}
\begin{document}
Hello
\foo{bar}
World
\end{document}
T
mk missing-dollar <<'T'
\documentclass{article}
\begin{document}
The value x_1 is small.
\end{document}
T
mk undefined-refs <<'T'
\documentclass{article}
\begin{document}
See Section~\ref{sec:nope} and \cite{ghost}.
\end{document}
T
mk overfull-underfull <<'T'
\documentclass{article}
\begin{document}
\noindent\hbox to 20pt{This is definitely too wide for the box}

\vbox to 10pt{Hello\par\vfill}
\hbadness=0
\noindent\hbox to 300pt{\hfil A\hfil}
\end{document}
T
mk missing-input <<'T'
\documentclass{article}
\begin{document}
Before.
\input{nonexistent-chapter}
After.
\end{document}
T
mk missing-package <<'T'
\documentclass{article}
\usepackage{nonexistentpkg}
\begin{document}
Hi
\end{document}
T
mk env-mismatch <<'T'
\documentclass{article}
\begin{document}
\begin{itemize}
\item one
\end{document}
T
mk runaway <<'T'
\documentclass{article}
\begin{document}
\textbf{unclosed argument
Next paragraph.

\end{document}
T
mk math-errors <<'T'
\documentclass{article}
\begin{document}
$x^1^2$

Some text } here.

$$ \frac{1}{ $$
\end{document}
T
mk package-warning <<'T'
\documentclass{article}
\usepackage{hyperref}
\begin{document}
\section{A $\alpha$ title}
Text with \texorpdfstring{}{}.
\end{document}
T
mk nested-input-error <<'T'
\documentclass{article}
\begin{document}
\input{chapters/one}
\end{document}
T
mkdir -p "$WORK/nested-input-error/chapters"
printf 'Chapter one line.\n\n\\undefinedmacro here\n\nMore.\n' > "$WORK/nested-input-error/chapters/one.tex"
mk bibtex-warnings <<'T'
\documentclass{article}
\begin{document}
Cite \cite{known} and \cite{missing}.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
T
printf '@article{known,\n  author={A. Author},\n  title={A Title},\n  journal={J},\n  year={2020}\n}\n' > "$WORK/bibtex-warnings/refs.bib"
mk bibtex-nofile <<'T'
\documentclass{article}
\begin{document}
Cite \cite{known}.
\bibliographystyle{plain}
\bibliography{nofile}
\end{document}
T
mk xelatex-undefined <<'T'
\documentclass{article}
\begin{document}
Hi \bogus{x} there.
\end{document}
T
run xelatex-undefined xelatex
mk lualatex-undefined <<'T'
\documentclass{article}
\begin{document}
Hi \bogus{x} there.
\end{document}
T
run lualatex-undefined lualatex
mk unicode-path-error <<'T'
\documentclass{article}
\begin{document}
\input{sec/einführung}
\end{document}
T
mkdir -p "$WORK/unicode-path-error/sec"
printf 'Zeile eins\n\\kaputt\n' > "$WORK/unicode-path-error/sec/einführung.tex"
mk bibtex-syntax-error <<'T'
\documentclass{article}
\begin{document}
Cite \cite{known}.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
T
printf '@article{known,\n  author={A. Author}\n  title={A Title},\n  journal={J},\n  year={2020}\n}\n' > "$WORK/bibtex-syntax-error/refs.bib"
mk fancyhdr-warning <<'T'
\documentclass{article}
\usepackage{fancyhdr}
\pagestyle{fancy}
\setlength{\headheight}{5pt}
\begin{document}
Hello
\end{document}
T
mk overfull-paragraph <<'T'
\documentclass{article}
\begin{document}
Short intro text.

Supercalifragilisticexpialidocious\-nothyphenatable\hbox{antidisestablishmentarianism_and_other_unbreakable_stuff_here} more words.
\end{document}
T
for n in overfull-paragraph bibtex-syntax-error fancyhdr-warning clean undefined-command missing-dollar undefined-refs overfull-underfull missing-input missing-package env-mismatch runaway math-errors package-warning nested-input-error bibtex-warnings bibtex-nofile unicode-path-error; do run "$n" pdflatex; done
rm -rf "$WORK"
ls "$OUT"
