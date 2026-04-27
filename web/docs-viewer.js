import { marked } from 'marked';
import refMd  from '../docs/REFERENCIA.md?raw';
import tutMd  from '../docs/TUTORIAL.md?raw';
import planMd from '../docs/PLAN.md?raw';
import edMd   from '../docs/EDITOR_PLAN.md?raw';

const DOCS = {
  REFERENCIA:  { title: 'Referencia del lenguaje', md: refMd  },
  TUTORIAL:    { title: 'Tutorial: Serpiente',     md: tutMd  },
  PLAN:        { title: 'Plan de diseño',          md: planMd },
  EDITOR_PLAN: { title: 'Plan del editor',         md: edMd   },
};

const ORDER = ['REFERENCIA', 'TUTORIAL', 'PLAN', 'EDITOR_PLAN'];

const sel = document.getElementById('doc-select');
for (const k of ORDER) {
  const o = document.createElement('option');
  o.value = k;
  o.textContent = DOCS[k].title;
  sel.appendChild(o);
}

const params = new URLSearchParams(location.search);
const initial = params.get('doc') || 'REFERENCIA';
sel.value = DOCS[initial] ? initial : 'REFERENCIA';
render(sel.value);

sel.addEventListener('change', () => {
  history.replaceState(null, '', `?doc=${sel.value}`);
  render(sel.value);
  window.scrollTo(0, 0);
});

function render(key) {
  const doc = DOCS[key];
  if (!doc) return;
  document.title = `RetroVM — ${doc.title}`;
  // marked.parse devuelve HTML. Los .md no tienen contenido del usuario,
  // así que es seguro inyectarlo (sin necesidad de DOMPurify).
  document.getElementById('docs-content').innerHTML = marked.parse(doc.md);
}
