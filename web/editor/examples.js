// Carga todos los .retro de games/ a build-time vía Vite glob.
// import.meta.glob con eager:true genera un import estático por cada match,
// así el bundle final tiene los archivos como strings inlineados.

const modules = import.meta.glob('../../games/*.retro', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Mapa nombre → contenido del .retro. Filtramos los hito*.retro intermedios
// (dejamos solo los 5 ejemplos canónicos de Hito 8 + cualquier juego nuevo
// que no sea hitoN).
function isCanonicalGame(name) {
  return !/^hito\d+$/i.test(name);
}

export const EXAMPLES = Object.fromEntries(
  Object.entries(modules)
    .map(([path, src]) => {
      const name = path.replace(/^.*\//, '').replace(/\.retro$/, '');
      return [name, src];
    })
    .filter(([name]) => isCanonicalGame(name))
);

// Orden sugerido para el dropdown — del más simple al más complejo.
export const EXAMPLE_ORDER = ['pelota', 'pong', 'saltarin', 'memoria', 'serpiente', 'mario-mini', 'espacial'];

export function listExamples() {
  const known = EXAMPLE_ORDER.filter((n) => EXAMPLES[n]);
  const extras = Object.keys(EXAMPLES).filter((n) => !EXAMPLE_ORDER.includes(n)).sort();
  return [...known, ...extras];
}

export function getExample(name) {
  return EXAMPLES[name] || null;
}
