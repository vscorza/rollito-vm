import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { lintGutter } from '@codemirror/lint';
import { searchKeymap, search } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { retroLanguage } from './retro-mode.js';
import { retroLinter } from './linter-bridge.js';

// Paleta de syntax inspirada en monitores CRT y la default del VM.
// Las clases CSS finales las renderiza CodeMirror; los colores acá viven dentro
// del HighlightStyle (no necesitamos selectores CSS extra para tags).
const retroHighlight = HighlightStyle.define([
  { tag: t.keyword,      color: '#ff77a8', fontWeight: 'bold' },  // SI, EN, IR…
  { tag: t.typeName,     color: '#29adff' },                       // BOR, MOV…
  { tag: t.function(t.variableName), color: '#ffec27' },           // (no usado, pero por las dudas)
  { tag: t.function(t.name),         color: '#ffec27' },
  { tag: t.variableName, color: '#c0f0ff' },
  { tag: t.atom,         color: '#c0f0ff' },
  { tag: t.number,       color: '#ffa300' },
  { tag: t.string,       color: '#00e436' },
  { tag: t.comment,      color: '#5f574f', fontStyle: 'italic' },
  { tag: t.operator,     color: '#ff77a8' },
  { tag: t.punctuation,  color: '#83769c' },
  { tag: t.meta,         color: '#83769c' },                        // números de línea inline
]);

// Tema general del editor (fondo, gutter, cursor, selección).
const retroTheme = EditorView.theme({
  '&': {
    backgroundColor: '#0a1530',
    color: '#c0f0ff',
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
    fontSize: '14px',
    height: '100%',
  },
  '.cm-content': { caretColor: '#ffec27' },
  '.cm-cursor': { borderLeftColor: '#ffec27', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: '#1d2b53',
  },
  '.cm-gutters': {
    backgroundColor: '#000814',
    color: '#5f574f',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: '#0d1d3d' },
  '.cm-activeLineGutter': { backgroundColor: '#000814', color: '#ffec27' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px' },
  '.cm-tooltip': {
    backgroundColor: '#1d2b53',
    color: '#c0f0ff',
    border: '1px solid #29adff',
  },
  '.cm-diagnostic': {
    backgroundColor: 'transparent',
    color: '#c0f0ff',
  },
}, { dark: true });

export function createEditor(parent, initialDoc, onChange) {
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      lineNumbers(),
      lintGutter(),
      history(),
      highlightActiveLine(),
      retroLanguage,
      syntaxHighlighting(retroHighlight),
      retroTheme,
      retroLinter,
      search({ top: true }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((v) => {
        if (v.docChanged && onChange) onChange(v.state.doc.toString());
      }),
      EditorView.lineWrapping,
    ],
  });
  return new EditorView({ state, parent });
}

export function setEditorDoc(view, text) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}

export function getEditorDoc(view) {
  return view.state.doc.toString();
}

export function insertAtCursor(view, text) {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
  view.focus();
}
