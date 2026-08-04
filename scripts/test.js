/* ==================================================================
   test.js - Testes das funcoes puras de app.js
   Sem framework, sem build step: so node:assert e node test.js.
   Cobre parseHorario, dedupeHorarios, colorDistance/computeColorMap e esc.

   app.js espera DAYS/AULAS/PALETTE como globais (vem de config.js via
   <script> no navegador, sem module.exports). Em vez de mudar config.js
   pra virar um modulo, carregamos os dois arquivos com vm num mesmo
   "sandbox" que ja tem module.exports - assim config.js define as
   globais no mesmo escopo em que app.js roda, igual ao navegador faz.

   app.js tambem toca document/window/localStorage/fetch logo ao carregar
   (ex: `document.getElementById("subjectList")` fora de qualquer funcao),
   entao o sandbox precisa de stubs minimos desses objetos - nao pra
   simular o DOM de verdade, so pra deixar o arquivo carregar sem lancar
   erro antes de a gente chegar nas funcoes puras que queremos testar. */
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// Stub generico: qualquer propriedade acessada vira outro stub (tambem
// chamavel), entao cadeias tipo document.getElementById("x").addEventListener(...)
// ou window.matchMedia(...).matches nao quebram, mesmo sem DOM de verdade.
function makeStub() {
  const fn = function () {
    return makeStub();
  };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (!(prop in target)) target[prop] = makeStub();
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

const storageBacking = {};
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(storageBacking, k) ? storageBacking[k] : null),
  setItem: (k, v) => { storageBacking[k] = String(v); },
  removeItem: (k) => { delete storageBacking[k]; },
};

const sandbox = {
  module: { exports: {} },
  console,
  document: makeStub(),
  window: makeStub(),
  localStorage,
  fetch: () => Promise.reject(new Error("fetch indisponivel no ambiente de teste")),
  setTimeout,
  clearTimeout,
  navigator: { clipboard: { writeText: async () => {}, readText: async () => "" } },
};
vm.createContext(sandbox);

const configSrc = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
vm.runInContext(configSrc, sandbox, { filename: "config.js" });

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
vm.runInContext(appSrc, sandbox, { filename: "app.js" });

const {
  parseHorario,
  dedupeHorarios,
  hexToRgb,
  colorDistance,
  computeColorMap,
  esc,
  State,
} = sandbox.module.exports;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let passed = 0;
let total = 0;
function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`${GREEN}[OK]${RESET} ${name}`);
    passed++;
  } catch (e) {
    console.error(`${RED}[FALHOU]${RESET} ${name}`);
    console.error(`${RED}   ${e.message}${RESET}`);
    process.exitCode = 1;
  }
}

/* ============== parseHorario ============== */

test("parseHorario: bloco basico (dia, codigo, sala)", () => {
  assert.equal(
    JSON.stringify(parseHorario("5N1(CE-102)")),
    JSON.stringify([{ day: 5, code: "N1", room: "CE-102", otherCampus: false }])
  );
});

test("parseHorario: multiplos blocos separados por hifen", () => {
  const out = parseHorario("2M1(A-101)-2M2(A-101)");
  assert.equal(out.length, 2);
  assert.equal(JSON.stringify(out[0]), JSON.stringify({ day: 2, code: "M1", room: "A-101", otherCampus: false }));
  assert.equal(JSON.stringify(out[1]), JSON.stringify({ day: 2, code: "M2", room: "A-101", otherCampus: false }));
});

test("parseHorario: um asterisco marca outra sede (Ecoville)", () => {
  const out = parseHorario("6M1(*CE-303)");
  assert.equal(out[0].otherCampus, true);
  assert.equal(out[0].room, "CE-303");
});

test("parseHorario: dois asteriscos marca outra sede (Neoville)", () => {
  const out = parseHorario("6M2(**CE-303)");
  assert.equal(out[0].otherCampus, true);
  assert.equal(out[0].room, "CE-303");
});

test("parseHorario: string vazia ou nula retorna array vazio", () => {
  assert.equal(parseHorario("").length, 0);
  assert.equal(parseHorario(null).length, 0);
  assert.equal(parseHorario(undefined).length, 0);
});

test("parseHorario: codigo de aula inexistente em AULAS e ignorado", () => {
  // "9" nao e um turno valido (M/T/N), entao o regex nem casa esse bloco
  const out = parseHorario("5N1(CE-102)-9X9(ZZ-000)");
  assert.equal(out.length, 1);
  assert.equal(out[0].room, "CE-102");
});

test("parseHorario: usa cache - chamadas repetidas retornam o mesmo resultado", () => {
  const a = parseHorario("3T1(B-201)");
  const b = parseHorario("3T1(B-201)");
  assert.deepEqual(a, b);
});

/* ============== dedupeHorarios ============== */

test("dedupeHorarios: remove blocos exatamente duplicados", () => {
  const disciplinas = [
    { turmas: [{ h: "5N1(CE-102)-5N1(CE-102)" }] },
  ];
  dedupeHorarios(disciplinas);
  assert.equal(disciplinas[0].turmas[0].h, "5N1(CE-102)");
});

test("dedupeHorarios: preserva blocos diferentes, sem duplicar nem remover unicos", () => {
  const disciplinas = [
    { turmas: [{ h: "2M1(A-101)-2M2(A-101)" }] },
  ];
  dedupeHorarios(disciplinas);
  assert.equal(disciplinas[0].turmas[0].h, "2M1(A-101)-2M2(A-101)");
});

test("dedupeHorarios: preserva salas com hifen no nome (ex: CD-108)", () => {
  const disciplinas = [
    { turmas: [{ h: "5T2(CD-108)-5T2(CD-108)" }] },
  ];
  dedupeHorarios(disciplinas);
  assert.equal(disciplinas[0].turmas[0].h, "5T2(CD-108)");
});

test("dedupeHorarios: nao quebra quando turma.h e undefined", () => {
  const disciplinas = [{ turmas: [{}] }];
  assert.doesNotThrow(() => dedupeHorarios(disciplinas));
});

/* ============== hexToRgb / colorDistance / computeColorMap ============== */

test("hexToRgb: converte corretamente", () => {
  assert.equal(JSON.stringify(hexToRgb("#ffffff")), JSON.stringify({ r: 255, g: 255, b: 255 }));
  assert.equal(JSON.stringify(hexToRgb("#000000")), JSON.stringify({ r: 0, g: 0, b: 0 }));
});

test("colorDistance: cor identica tem distancia zero", () => {
  assert.equal(colorDistance("#2c6e49", "#2c6e49"), 0);
});

test("colorDistance: preto e branco tem a maior distancia possivel", () => {
  const d = colorDistance("#000000", "#ffffff");
  assert.ok(Math.abs(d - Math.sqrt(3 * 255 ** 2)) < 0.001);
});

test("computeColorMap: mesma ordem de codigos gera as mesmas cores (deterministico)", () => {
  const codes = ["MAT101", "FIS201", "PROG301"];
  const map1 = computeColorMap(codes);
  const map2 = computeColorMap(codes);
  codes.forEach((c) => assert.equal(map1.get(c), map2.get(c)));
});

test("computeColorMap: nao repete cor entre codigos diferentes (com paleta suficiente)", () => {
  const codes = ["MAT101", "FIS201", "PROG301"];
  const map = computeColorMap(codes);
  const colors = codes.map((c) => map.get(c));
  assert.equal(new Set(colors).size, colors.length);
});

/* ============== esc ============== */

test("esc: escapa &, <, >, e aspas duplas", () => {
  assert.equal(esc(`<b>Calculo & "Algebra"</b>`), "&lt;b&gt;Calculo &amp; &quot;Algebra&quot;&lt;/b&gt;");
});

test("esc: trata null/undefined como string vazia", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

test("esc: nao altera texto sem caracteres especiais", () => {
  assert.equal(esc("Calculo I"), "Calculo I");
});

/* ============== STATE: TEMPLATES (botoes 1/2/3) ==============
   Usa sede/curso "de mentira" (sede-teste, curso-teste-*) so pra isolar
   esses testes de qualquer chave real que a UI use no localStorage -
   State.switchCourse() so monta strings de chave, nao busca nada pela
   rede, entao funciona igual num curso real ou inventado. Cada test()
   comeca com State.switchCourse() de novo pra nao herdar estado deixado
   por um teste anterior (o State e um singleton compartilhado pelo
   arquivo inteiro, igual seria no navegador). */

function fakeSub(code, name) {
  return { code, name };
}
function fakeTurma(turma, h) {
  return { turma, prof: "Prof. Teste", h, enq: "", vt: 1, vc: 1, res: "aberta", prio: false, opt: false };
}
function selecionarFake(code, name, turma, h) {
  State.selectTurma(fakeSub(code, name), fakeTurma(turma, h), parseHorario(h));
}

test("State.switchCourse: comeca sempre no template 1", () => {
  State.switchCourse("sede-teste", "curso-teste-templates");
  assert.equal(State.getActiveTemplate(), "1");
});

test("State: cada template guarda sua propria selecao de turmas", () => {
  State.switchCourse("sede-teste", "curso-teste-templates");
  selecionarFake("MAT101", "Calculo I", "A", "5N1(CE-102)");
  assert.ok(State.isSelected("MAT101"));

  State.switchTemplate("2");
  assert.equal(State.countSelected(), 0, "template 2 deve comecar vazio");
  selecionarFake("FIS201", "Fisica I", "B", "3T1(B-201)");
  assert.ok(State.isSelected("FIS201"));

  State.switchTemplate("1");
  assert.ok(State.isSelected("MAT101"), "template 1 deve manter o que foi selecionado nele");
  assert.ok(!State.isSelected("FIS201"), "template 1 nao deve enxergar a selecao do template 2");

  State.switchTemplate("2");
  assert.ok(State.isSelected("FIS201"), "template 2 deve manter sua propria selecao ao voltar pra ele");
  assert.ok(!State.isSelected("MAT101"));
});

test("State: a selecao de cada template fica salva no localStorage com chave propria", () => {
  State.switchCourse("sede-teste", "curso-teste-templates");
  selecionarFake("MAT101", "Calculo I", "A", "5N1(CE-102)");
  State.switchTemplate("2");
  selecionarFake("FIS201", "Fisica I", "B", "3T1(B-201)");
  State.switchTemplate("1"); // forca o save() do template 2 antes de ler o localStorage

  const raw1 = localStorage.getItem("utfpr_horario_v2_sede-teste_curso-teste-templates_t1");
  const raw2 = localStorage.getItem("utfpr_horario_v2_sede-teste_curso-teste-templates_t2");
  assert.ok(raw1 && raw1.includes("MAT101"), "template 1 deve estar salvo com chave propria (_t1)");
  assert.ok(raw2 && raw2.includes("FIS201"), "template 2 deve estar salvo com chave propria (_t2)");
});

test("State.switchTemplate: clicar no template ja ativo nao reseta nada", () => {
  State.switchCourse("sede-teste", "curso-teste-noop");
  selecionarFake("MAT101", "Calculo I", "A", "5N1(CE-102)");
  State.switchTemplate("1"); // ja esta no "1"
  assert.ok(State.isSelected("MAT101"), "selecionar o template ja ativo nao pode limpar a selecao");
  assert.ok(State.canUndo(), "nem o historico de desfazer");
});

test("State.switchCourse: trocar de curso sempre volta pro template 1", () => {
  State.switchCourse("sede-teste", "curso-teste-templates");
  State.switchTemplate("3");
  assert.equal(State.getActiveTemplate(), "3");

  State.switchCourse("sede-teste", "outro-curso-teste");
  assert.equal(State.getActiveTemplate(), "1", "trocar de curso deve resetar pro template 1");
  assert.equal(State.countSelected(), 0, "curso novo deve comecar sem selecao");
});

test("State.switchCourse: trocar de sede tambem volta pro template 1", () => {
  State.switchCourse("sede-teste", "curso-teste-templates");
  State.switchTemplate("2");
  State.switchCourse("outra-sede-teste", "curso-teste-templates");
  assert.equal(State.getActiveTemplate(), "1", "trocar de sede deve resetar pro template 1");
});

test("State: alternar entre templates preserva o historico de desfazer/refazer de cada um", () => {
  State.switchCourse("sede-teste", "curso-teste-undo");

  selecionarFake("MAT101", "Calculo I", "A", "5N1(CE-102)");
  assert.ok(State.canUndo(), "template 1 deve ter historico apos selecionar uma turma");

  State.switchTemplate("2");
  assert.ok(!State.canUndo(), "template 2 comeca sem historico de desfazer");
  selecionarFake("FIS201", "Fisica I", "B", "3T1(B-201)");
  assert.ok(State.canUndo(), "template 2 deve ganhar historico apos selecionar uma turma nele");

  State.switchTemplate("1");
  assert.ok(State.canUndo(), "voltar ao template 1 deve restaurar o historico dele");
  assert.ok(State.undo(), "desfazer no template 1 deve funcionar");
  assert.ok(!State.isSelected("MAT101"), "desfazer deve remover a selecao feita no template 1");

  State.switchTemplate("2");
  assert.ok(State.isSelected("FIS201"), "template 2 nao pode ser afetado pelo desfazer feito no template 1");
  assert.ok(State.canUndo(), "historico do template 2 continua intacto");
});

test("State: grade salva antes dos templates existirem e migrada pro template 1", () => {
  const sede = "sede-teste";
  const curso = "curso-teste-migracao";
  const legacyKey = `utfpr_horario_v2_${sede}_${curso}`;
  const t1Key = `${legacyKey}_t1`;
  localStorage.setItem(legacyKey, JSON.stringify({ MAT101: { code: "MAT101", name: "Calculo I" } }));

  State.switchCourse(sede, curso);

  assert.equal(State.getActiveTemplate(), "1", "deve abrir no template 1");
  assert.ok(State.isSelected("MAT101"), "a grade salva antes dos templates deve aparecer no template 1");
  assert.equal(localStorage.getItem(t1Key), JSON.stringify({ MAT101: { code: "MAT101", name: "Calculo I" } }), "deve ter copiado o valor antigo pra chave do template 1");
  assert.equal(localStorage.getItem(legacyKey), null, "a chave antiga deve ser removida apos a migracao");
});

test("State: migracao nao sobrescreve o template 1 se ele ja tiver dados proprios", () => {
  const sede = "sede-teste";
  const curso = "curso-teste-migracao-2";
  const legacyKey = `utfpr_horario_v2_${sede}_${curso}`;
  const t1Key = `${legacyKey}_t1`;
  localStorage.setItem(t1Key, JSON.stringify({ FIS201: { code: "FIS201", name: "Fisica I" } }));
  localStorage.setItem(legacyKey, JSON.stringify({ MAT101: { code: "MAT101", name: "Calculo I" } }));

  State.switchCourse(sede, curso);

  assert.ok(State.isSelected("FIS201"), "dados ja existentes no template 1 nao devem ser substituidos");
  assert.ok(!State.isSelected("MAT101"), "o valor antigo nao deve sobrescrever um template 1 ja em uso");
});

/* ============== VALIDACAO DOS ARQUIVOS data/*.json ==============
   Diferente dos testes acima (que usam strings de exemplo fixas), esta
   secao le de verdade os arquivos data/sedes.json, data/<sede>/manifest.json
   e data/<sede>/<slug>.json do repositorio e confere se cada um esta bem
   formado. E o que pega o caso de cortar/corromper texto sem querer num
   desses arquivos: como as strings de exemplo acima nunca mudam, elas nao
   detectam esse tipo de erro - aqui sim. */

const DATA_DIR = path.join(__dirname, "..", "data");

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

test("data/sedes.json existe e e um JSON valido", () => {
  assert.ok(fs.existsSync(path.join(DATA_DIR, "sedes.json")), "data/sedes.json nao encontrado");
  const sedes = readJsonFile(path.join(DATA_DIR, "sedes.json"));
  assert.ok(Array.isArray(sedes) && sedes.length > 0, "data/sedes.json deve ser um array nao vazio");
  sedes.forEach((s) => {
    assert.ok(typeof s.slug === "string" && s.slug.length > 0, "sede sem slug valido");
    assert.ok(typeof s.label === "string" && s.label.length > 0, `sede "${s.slug}" sem label valido`);
  });
});

// So roda os testes por sede/curso se sedes.json existir e for valido -
// senao o teste acima ja falhou e nao ha nada de util pra checar aqui.
let sedesList = [];
try {
  sedesList = readJsonFile(path.join(DATA_DIR, "sedes.json"));
} catch (e) {
  sedesList = [];
}

sedesList.forEach((sede) => {
  const manifestPath = path.join(DATA_DIR, sede.slug, "manifest.json");

  test(`data/${sede.slug}/manifest.json existe e e um JSON valido`, () => {
    assert.ok(fs.existsSync(manifestPath), `manifest.json nao encontrado para a sede "${sede.slug}"`);
    const cursos = readJsonFile(manifestPath);
    assert.ok(Array.isArray(cursos) && cursos.length > 0, `manifest de "${sede.slug}" deve ser um array nao vazio`);
    cursos.forEach((c) => {
      assert.ok(typeof c.slug === "string" && c.slug.length > 0, "curso sem slug valido");
      assert.ok(typeof c.label === "string" && c.label.length > 0, `curso "${c.slug}" sem label valido`);
    });
  });

  let cursos = [];
  try {
    cursos = readJsonFile(manifestPath);
  } catch (e) {
    cursos = [];
  }

  cursos.forEach((curso) => {
    const cursoPath = path.join(DATA_DIR, sede.slug, `${curso.slug}.json`);
    const label = `data/${sede.slug}/${curso.slug}.json`;

    test(`${label} existe e e um JSON valido`, () => {
      assert.ok(fs.existsSync(cursoPath), `${label} nao encontrado (listado no manifest de "${sede.slug}")`);
      const disciplinas = readJsonFile(cursoPath);
      assert.ok(Array.isArray(disciplinas) && disciplinas.length > 0, `${label} deve ser um array nao vazio`);
    });

    test(`${label}: disciplinas tem code/name/turmas validos`, () => {
      const disciplinas = readJsonFile(cursoPath);
      disciplinas.forEach((d, i) => {
        assert.ok(typeof d.code === "string" && d.code.length > 0, `disciplina no indice ${i} sem code valido`);
        assert.ok(typeof d.name === "string" && d.name.length > 0, `disciplina "${d.code}" sem name valido`);
        assert.ok(Array.isArray(d.turmas) && d.turmas.length > 0, `disciplina "${d.code}" sem turmas`);
      });
    });

    test(`${label}: nao ha codigos de disciplina duplicados`, () => {
      const disciplinas = readJsonFile(cursoPath);
      const codes = disciplinas.map((d) => d.code);
      const unique = new Set(codes);
      assert.equal(unique.size, codes.length, "ha codigos de disciplina repetidos nesse arquivo");
    });

    test(`${label}: quando h existe, e sempre parseavel`, () => {
      // Disciplinas sem horario fixo (TCC, estagio, atividades
      // complementares etc.) legitimamente nao tem "h" - o proprio
      // app.js ja trata isso (dedupeHorarios so mexe em turma.h se
      // "if (turma.h)"). Entao so validamos o parse quando h existir
      // de verdade; ausencia de h nao e erro.
      const disciplinas = readJsonFile(cursoPath);
      disciplinas.forEach((d) => {
        d.turmas.forEach((t, i) => {
          if (!t.h) return;
          const slots = parseHorario(t.h);
          assert.ok(slots.length > 0, `turma ${i} de "${d.code}" tem h="${t.h}" que nao gera nenhum horario valido`);
        });
      });
    });
  });
});


const summaryColor = passed === total ? GREEN : RED;
console.log(`\n${summaryColor}${passed}/${total} testes passaram.${RESET}`);
