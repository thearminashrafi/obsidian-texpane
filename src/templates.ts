export const ARTICLE_TEMPLATE = `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage[hidelinks]{hyperref}

\\title{Untitled}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Start writing here.

\\end{document}
`;

export const PROJECT_MAIN = (title: string) => `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage[hidelinks]{hyperref}

\\title{${title.replace(/[\\{}$&#^_%~]/g, " ")}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Start writing here. Cite a reference like this~\\cite{example}.

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`;

export const PROJECT_BIB = `@book{example,
  author    = {Donald E. Knuth},
  title     = {The {TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`;
