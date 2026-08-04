/* ==================================================================
   app.js — Lógica do MontaHorário UTFPR
   Depende de config.js (DAYS, AULAS, PALETTE) já carregado antes.
   As disciplinas (DATA) não vêm mais de um <script> fixo: cada curso
   é um data/<slug>.json carregado sob demanda via fetch (ver seção
   "CARREGAMENTO DE CURSO" perto do fim do arquivo).
   Tudo fica dentro de uma IIFE: nada aqui vaza para o escopo global,
   exceto o que já vem de config.js.
   ================================================================== */
(function () {
  "use strict";

  /* Disciplinas do curso atualmente carregado. Começa vazio e é
     preenchido por applyDataset() sempre que um data/<slug>.json
     termina de carregar (na primeira vez ou ao trocar de curso). */
  let DATA = [];

  /* Em vez de checar UMA VEZ se o aparelho "tem hover" (isso não cobre um
     iPad que ganha um mouse/trackpad depois de carregar a página, ou perde
     ele), os efeitos de passar-o-mouse abaixo usam Pointer Events e olham
     o pointerType de CADA evento: só ativam quando pointerType === "mouse"
     (ou "pen"). Toque (pointerType === "touch") nunca aciona preview nem
     hover cruzado, então não tem como grudar. */

  /* ============== REMOVEDOR DE DUPLICATAS ==============
     Lê um array de disciplinas (no formato do data/<slug>.json) e
     remove blocos de horários exatamente iguais antes de montar os
     índices, preservando salas com hífen (ex: CD-108). Roda uma vez
     por curso carregado, não uma vez só na inicialização. */
  function dedupeHorarios(disciplinas) {
    disciplinas.forEach(disciplina => {
      disciplina.turmas.forEach(turma => {
        if (turma.h) {
          // Usa RegEx para capturar os blocos "5T2(CD-108)" em vez de split('-')
          const blocos = turma.h.match(/\d[MTN]\d\s*\([^)]*\)/g);
          if (blocos) {
            // Remove as duplicatas exatas e junta com hífen novamente
            turma.h = [...new Set(blocos)].join('-');
          }
        }
      });
    });
  }
  /* ============== ÍNDICE AUXILIAR (derivado de AULAS, de config.js) ============== */
  const AULA_INDEX = {};
  AULAS.forEach((a, i) => { AULA_INDEX[a.code] = i; });

  /* ============== ESCAPE DE HTML ==============
     Todo texto vindo do dataset (ou de qualquer fonte futura, como uma
     API) passa por aqui antes de entrar no DOM via innerHTML — mesmo
     sendo dados estáticos hoje, isso evita que o app quebre ou vire um
     vetor de XSS caso um dia passe a consumir dados dinâmicos. */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* ============== PARSER ============== */
  // entrada: "5N1(CE-102)-5N2(CE-102)-6M1(*CE-303)-6M2(**CE-303)"
  // asteriscos indicam sede diferente (Ecoville/Neoville)
  const parseHorarioCache = new Map(); // h (string) -> slots já parseados
  function parseHorario(h) {
    if (!h) return [];
    const cached = parseHorarioCache.get(h);
    if (cached) return cached;
    const regex = /(\d)([MTN])(\d)\s*\(([^)]*)\)/g;
    let m; const out = [];
    while ((m = regex.exec(h)) !== null) {
      const day = parseInt(m[1], 10);
      const code = m[2] + m[3];
      let roomRaw = m[4].trim();
      let otherCampus = false;
      if (roomRaw.startsWith("**")) { otherCampus = true; roomRaw = roomRaw.slice(2); }
      else if (roomRaw.startsWith("*")) { otherCampus = true; roomRaw = roomRaw.slice(1); }
      if (AULA_INDEX[code] === undefined) continue;
      out.push({ day, code, room: roomRaw, otherCampus });
    }
    parseHorarioCache.set(h, out);
    return out;
  }
/* Converte "#rrggbb" para {r,g,b} */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* Distância euclidiana simples entre duas cores — quanto maior, mais
   visualmente diferentes elas são uma da outra. */
function colorDistance(hexA, hexB) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/* Escolhe, para cada código (na ordem dada), a cor da PALETTE que fica
   mais distante das já escolhidas antes dela — maximizando o contraste
   entre as matérias selecionadas ao mesmo tempo. A ordem é preservada
   entre chamadas (mesmo prefixo de códigos = mesmas cores), então
   selecionar/remover uma matéria não embaralha a cor das demais. */
/* Calcula, de uma vez só, a cor de cada código de uma lista ordenada —
   mesmo algoritmo de maximizar distância entre cores, mas processando
   a lista inteira em uma única passada em vez de recomeçar do zero pra
   cada código. Use isso quando precisar da cor de VÁRIOS códigos ao
   mesmo tempo (ex: toda a lista de disciplinas em um render), em vez de
   chamar subjectColor() um a um — economiza o O(n × paleta) repetido. */
function computeColorMap(codes) {
  const map = new Map();
  const assigned = [];
  for (const c of codes) {
    let best = PALETTE[0], bestScore = -1;
    for (const hex of PALETTE) {
      const minDist = assigned.length
        ? Math.min(...assigned.map(h => colorDistance(hex, h)))
        : Infinity;
      if (minDist > bestScore) { bestScore = minDist; best = hex; }
    }
    assigned.push(best);
    map.set(c, best);
  }
  return map;
}

/* Cor de UM código específico, dado o contexto (ordem) das selecionadas.
   Por baixo dos panos usa computeColorMap — mantido pros poucos lugares
   que só precisam de um código por vez (selecionar/colar uma turma).
   Para pintar uma lista inteira, prefira computeColorMap() direto. */
function subjectColor(code, contextCodes) {
  const selectedCodes = contextCodes || Object.keys(State.getSelected());
  const codes = selectedCodes.includes(code) ? selectedCodes : [...selectedCodes, code];
  return computeColorMap(codes).get(code);
}

  /* ============== ESTADO DA APLICAÇÃO ==============
     Toda informação mutável (seleção atual, disciplinas expandidas,
     filtro ativo, pilha de desfazer/refazer, preview de hover) fica
     encapsulada aqui dentro, em vez de espalhada em variáveis globais.
     O resto do código só lê e modifica o estado através dos métodos
     abaixo — nenhuma função fora daqui faz `selected[x] = y` diretamente. */
  const State = (function () {
    let selected = {};              // {codigo: {..dados da turma escolhida..}}
    let openSubjects = new Set();   // códigos de disciplinas expandidas na lista
    let openInfo = new Set();       // códigos com o painel de detalhes da turma ativa aberto
    // Turmas fixadas (pin), só usado/exibido no modo compacto. Guardado por
    // disciplina: {codigo_da_materia: [turma1, turma2, ...]} na ORDEM em que
    // foram fixadas — essa ordem é a ordem final de exibição (1ª fixada vai
    // pra 1ª posição, 2ª fixada pra 2ª, etc). Não entra na pilha de
    // desfazer/refazer nem é persistido: é só um atalho de visualização.
    let pinned = {};
    let filterMode = "all";         // "all" | "selected" | "conflict"
    let previewSlots = null;        // {slots, conflict} enquanto o mouse está sobre uma turma
    let undoStack = [];
    let redoStack = [];
    // Histórico de desfazer/refazer de cada template (1/2/3), guardado só
    // em memória (não vai pro localStorage — "por sessão": some ao
    // recarregar a página, mas fica preservado ao alternar entre
    // templates enquanto a aba continua aberta). Indexado pelo id do
    // template ("1"/"2"/"3"); é zerado inteiro em switchCourse(), já que
    // aí é um curso novo.
    let undoRedoByTemplate = {};
    let lastSelectedCode = null;    // código da última matéria escolhida (destaque azul na mini-grade)
    // A chave de storage inclui o slug do curso: cada curso guarda sua
    // própria seleção separadamente (trocar de curso não apaga nem
    // mistura o que foi salvo nos outros). Além disso, cada curso tem 3
    // "templates" de grade independentes (botões 1/2/3 na tela) — por
    // isso a chave final também leva o template ativo no final
    // ("..._t1", "..._t2", "..._t3"). Trocar de curso/sede sempre volta
    // para o template "1" (activeTemplate abaixo).
    let baseStorageKey = "utfpr_horario_v2";
    let activeTemplate = "1";
    // Chave de storage das turmas fixadas (pin) — mesmo esquema do
    // baseStorageKey acima: namespaced por sede+curso em switchCourse(), pra
    // cada curso/sede guardar seus próprios pins sem misturar com os
    // de outro curso.
    let PIN_STORAGE_KEY = "utfpr_pinned_v1";

    function templateStorageKey() { return baseStorageKey + "_t" + activeTemplate; }

    // Antes dos templates existirem, a grade de cada curso ficava salva
    // direto em "utfpr_horario_v2_<sede>_<slug>" (sem sufixo de
    // template). Agora o app só lê de "..._t1/_t2/_t3", então, sem essa
    // migração, quem já tinha uma grade montada veria ela "sumir" ao
    // abrir o app de novo — os dados continuariam no localStorage, só
    // que numa chave que ninguém mais olha. Aqui a gente copia esse
    // valor antigo (se existir) pra dentro do template 1 na primeira
    // vez que o curso é aberto depois da atualização, e apaga a chave
    // antiga (evita reprocessar essa migração toda vez, e evita ela
    // sobrescrever o template 1 se o usuário já tiver mexido nele desde
    // então — só migra se o template 1 ainda estiver vazio).
    function migrateLegacyStorage() {
      const legacyKey = baseStorageKey;
      const t1Key = baseStorageKey + "_t1";
      try {
        const legacyRaw = localStorage.getItem(legacyKey);
        if (legacyRaw && !localStorage.getItem(t1Key)) {
          localStorage.setItem(t1Key, legacyRaw);
        }
        if (legacyRaw) localStorage.removeItem(legacyKey);
      } catch (e) { /* localStorage indisponível ou corrompido: ignora */ }
    }

    function snapshot() { return JSON.stringify(selected); }

    return {
      getSelected() { return selected; },
      isSelected(code) { return !!selected[code]; },
      countSelected() { return Object.keys(selected).length; },

      selectTurma(sub, t, slots) {
        this.pushUndo();
        selected[sub.code] = {
          code: sub.code, name: sub.name, turma: t.turma, prof: t.prof, h: t.h, slots,
          color: subjectColor(sub.code),
          enq: t.enq, vt: t.vt, vc: t.vc, res: t.res, prio: t.prio, opt: t.opt
        };
        lastSelectedCode = sub.code;
        this.save();
      },
      getLastSelected() { return lastSelectedCode; },
      removeSubject(code) {
        this.pushUndo();
        delete selected[code];
        openInfo.delete(code);
        if (lastSelectedCode === code) lastSelectedCode = null;
        this.save();
      },
      replaceSelection(newSelected) {
        this.pushUndo();
        selected = newSelected;
        openInfo.clear();
        lastSelectedCode = null;
        this.save();
      },
      clearSelection() {
        this.pushUndo();
        selected = {};
        openInfo.clear();
        lastSelectedCode = null;
        this.save();
      },
      // Usado só na inicialização: remove entradas cujo código/turma não
      // existam mais no dataset e atualiza slots/cor das válidas.
      // Não passa pela pilha de desfazer (não é uma "ação" do usuário).
      pruneAndRefresh(resolve) {
        Object.keys(selected).forEach(code => {
          const result = resolve(code, selected[code]);
          if (!result) { delete selected[code]; return; }
          selected[code].slots = result.slots;
          selected[code].color = result.color;
        });
      },

      isOpen(code) { return openSubjects.has(code); },
      toggleOpen(code) {
        if (openSubjects.has(code)) openSubjects.delete(code); else openSubjects.add(code);
      },
      closeAllOpen() { openSubjects = new Set(); },

      // Controla se o painel de detalhes (horário, vagas, etc.) de uma
      // turma ativa está expandido. É puramente de exibição — não entra
      // na pilha de desfazer/refazer nem é persistido.
      isInfoOpen(code) { return openInfo.has(code); },
      toggleInfo(code) {
        if (openInfo.has(code)) openInfo.delete(code); else openInfo.add(code);
      },

      // Fixar/desafixar uma turma dentro da lista de uma disciplina. Ao
      // fixar, a turma entra no FIM da lista de fixadas (última fixada =
      // última entre as fixadas); ao desafixar, sai de onde estiver.
      isPinned(code, turma) {
        return !!(pinned[code] && pinned[code].includes(turma));
      },
      togglePin(code, turma) {
        const list = pinned[code] || (pinned[code] = []);
        const idx = list.indexOf(turma);
        if (idx === -1) list.push(turma);
        else {
          list.splice(idx, 1);
          if (list.length === 0) delete pinned[code];
        }
        this.savePinned();
      },
      getPinnedOrder(code) {
        return pinned[code] || [];
      },
      loadPinned() {
        try {
          const raw = localStorage.getItem(PIN_STORAGE_KEY);
          pinned = raw ? JSON.parse(raw) : {};
        } catch (e) { pinned = {}; /* estado corrompido: ignora e começa vazio */ }
      },
      savePinned() {
        localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(pinned));
      },

      getFilterMode() { return filterMode; },
      setFilterMode(mode) { filterMode = mode; },

      getPreview() { return previewSlots; },
      setPreview(p) { previewSlots = p; },

      pushUndo() {
        undoStack.push(snapshot());
        if (undoStack.length > 50) undoStack.shift();
        redoStack = [];
      },
      canUndo() { return undoStack.length > 0; },
      canRedo() { return redoStack.length > 0; },
      undo() {
        if (!undoStack.length) return false;
        redoStack.push(snapshot());
        selected = JSON.parse(undoStack.pop());
        this.save();
        return true;
      },
      redo() {
        if (!redoStack.length) return false;
        undoStack.push(snapshot());
        selected = JSON.parse(redoStack.pop());
        this.save();
        return true;
      },

      getActiveTemplate() { return activeTemplate; },

      load() {
        try {
          const raw = localStorage.getItem(templateStorageKey());
          selected = raw ? JSON.parse(raw) : {};
        } catch (e) { selected = {}; /* estado corrompido: ignora e começa vazio */ }
      },
      save() {
        localStorage.setItem(templateStorageKey(), snapshot());
      },

      // Chamado ao clicar num dos botões de template (1/2/3): salva a
      // grade atual na chave do template que estava ativo, troca para o
      // template escolhido e carrega a grade salva dele (ou vazia, se
      // ainda não houver nada salvo). Cada template guarda sua própria
      // seleção, accordions/desfazer-refazer não fazem sentido entre um
      // template e outro, então são resetados aqui também.
      switchTemplate(id) {
        if (id === activeTemplate) return;
        this.save();
        undoRedoByTemplate[activeTemplate] = { undo: undoStack, redo: redoStack };
        activeTemplate = id;
        openSubjects = new Set();
        openInfo = new Set();
        previewSlots = null;
        const saved = undoRedoByTemplate[id];
        undoStack = saved ? saved.undo : [];
        redoStack = saved ? saved.redo : [];
        lastSelectedCode = null;
        this.load();
      },

      // Chamado ao trocar de curso: aponta o storage para a chave do
      // novo curso, namespaced por sede (cada curso de cada sede tem sua
      // própria "utfpr_horario_v2_<sede>_<slug>" — evita colisão caso duas
      // sedes venham a ter cursos com o mesmo slug), volta o template
      // ativo para "1", carrega a seleção salva desse curso/template (se
      // houver) e limpa todo estado de UI/histórico que só fazia sentido
      // para o curso anterior (accordions abertos, desfazer/refazer,
      // preview de hover etc.).
      switchCourse(sedeSlug, slug) {
        baseStorageKey = "utfpr_horario_v2_" + sedeSlug + "_" + slug;
        PIN_STORAGE_KEY = "utfpr_pinned_v1_" + sedeSlug + "_" + slug;
        activeTemplate = "1";
        undoRedoByTemplate = {};
        migrateLegacyStorage();
        selected = {};
        openSubjects = new Set();
        openInfo = new Set();
        pinned = {};
        previewSlots = null;
        undoStack = [];
        redoStack = [];
        lastSelectedCode = null;
        this.load();
        this.loadPinned();
      }
    };
  })();

  function horarioDisplay(h) {
    if (!h) return "<i>sem horário fixo (EaD / TCC / assíncrono)</i>";
    const slots = parseHorario(h);
    if (!slots.length) return esc(h);
    return slots.map(s => {
      const dayLbl = DAYS.find(d => d.n === s.day);
      const roomHtml = s.otherCampus
        ? `<span class="other-campus">${esc(s.room)}*</span>`
        : esc(s.room);
      return `${dayLbl ? esc(dayLbl.label.slice(0, 3)) : s.day} ${esc(s.code)} (${roomHtml})`;
    }).join(" &middot; ");
  }

  /* Monta o texto completo do tooltip (title nativo) com todos os campos da turma.
     Recebe dois objetos (sub, t) que juntos tenham: name, code, turma, enq, vt,
     vc, res, prio, h, prof, opt — usado tanto para a lista quanto para a grade. */
  function turmaTooltip(sub, t) {
    const linhas = [
      `${sub.name} (${sub.code})`,
      `Turma: ${t.turma}`,
      `Enquadramento: ${t.enq || "-"}`,
      `Vagas Total: ${t.vt || "-"}`,
      `Vagas Calouros: ${t.vc || "-"}`,
      `Reserva: ${t.res || "-"}`,
      `Prioridade - Curso: ${t.prio || "-"}`,
      `Horário (dia/turno/aula): ${t.h || "sem horário fixo"}`,
      `Professor (Sujeito à alteração): ${t.prof || "-"}`,
      `Optativa (Observar Equivalências): ${t.opt || "-"}`
    ];
    return esc(linhas.join("\n"));
  }

  /* Monta o texto curto de vagas ("Vagas:30" ou "Vagas:30 Cal.:5") a
     partir dos campos vt (vagas total) e vc (vagas calouros) de uma
     turma. Quando vt é "0", exibe "-" no lugar (sem vaga = sem
     número fazendo sentido mostrar). Só mostra a parte "Cal." quando
     existe reserva de vagas para calouros (vc presente e maior que
     zero) — igual antes. */
  function vagasLabel(t) {
    if (!t || t.vt === undefined || t.vt === null || t.vt === "" || t.vt === "-") return "";
    const vtDisplay = Number(t.vt) === 0 ? "-" : t.vt;
    let label = `Vagas:${vtDisplay}`;
    const vc = t.vc;
    if (vc !== undefined && vc !== null && vc !== "" && vc !== "-" && Number(vc) > 0) {
      label += ` Cal.:${vc}`;
    }
    return label;
  }

  /* checa conflito de um conjunto de slots candidatos contra a seleção atual,
     ignorando um código específico */
  function wouldConflict(slots, ignoreCode) {
    const occ = computeOccupancy(ignoreCode);
    for (const s of slots) {
      const key = s.day + "-" + s.code;
      if (occ[key] && occ[key].length > 0) return true;
    }
    return false;
  }

  /* ============== RENDER SUBJECT LIST ============== */
  const subjectListEl = document.getElementById("subjectList");
  const searchBox = document.getElementById("searchBox");

  /* Remove acentos/diacríticos para permitir busca "algebra" encontrar "álgebra" */
  function normalizeText(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function renderSubjectList(occ) {
    const q = normalizeText(searchBox.value.trim());
    // A lista inteira é reconstruída (innerHTML="" + reapend de tudo) a
    // cada seleção/remoção — em touch (especialmente iOS), zerar o
    // conteúdo por um instante zera também o scrollHeight do container,
    // e o navegador "clampa" o scrollTop dele a 0 nesse meio-tempo; depois
    // que o conteúdo volta, o scroll não é restaurado sozinho. Isso fazia
    // a lista pular pro topo sozinha ao selecionar uma turma mais abaixo.
    // Guardamos o scrollTop de antes e reaplicamos no fim, depois que todo
    // o conteúdo novo já foi inserido de volta.
    const prevScrollTop = subjectListEl.scrollTop;
    subjectListEl.innerHTML = "";
    const conflictSet = computeConflictCodes(occ);
    const selected = State.getSelected();
    const filterMode = State.getFilterMode();
    // Modo compacto: cada painel de turmas (matéria aberta) com muitas
    // opções vira 2 colunas em vez de scroll longo — ver uso de "two-col"
    // logo abaixo, aplicado por matéria (cada uma pode ter uma quantidade
    // diferente de turmas).
    const compactOn = document.documentElement.getAttribute("data-compact") === "true";

    DATA.forEach(sub => {
      const isSelected = State.isSelected(sub.code);
      if (filterMode === "selected" && !isSelected) return;
      if (filterMode === "conflict" && !conflictSet.has(sub.code)) return;
      if (q) {
        const hay = normalizeText(sub.code + " " + sub.name + " " + sub.turmas.map(t => t.prof + " " + t.turma).join(" "));
        if (!hay.includes(q)) return;
      }
      const div = document.createElement("div");
      div.className = "subject" + (isSelected ? " selected" : "") + (State.isOpen(sub.code) ? " open" : "");
      div.setAttribute("data-code", sub.code);
      // Usa a MESMA cor já fixada em selected[code].color (definida uma
      // única vez ao selecionar a turma — ver State.selectTurma) em vez de
      // recalcular na hora: recalcular aqui reordenava as cores de outras
      // matérias já selecionadas sempre que uma matéria era removida
      // (a cor de cada uma dependia da posição das demais na lista de
      // selecionadas), fazendo a lista mostrar uma cor diferente da usada
      // na grade/legenda para a mesma matéria.
      const color = isSelected ? selected[sub.code].color : null;
      // Selo "EAD" ao lado do nome da matéria: some quando a turma
      // SELECIONADA é EAD, e também temporariamente ao passar o mouse
      // sobre qualquer turma da lista (ver setHeaderInfo() mais abaixo).
      // O indicador de EAD vem do campo "enq" (ex.: "EaD" vs "Presencial").
      const hasEAD = isSelected && /\bead\b/i.test(selected[sub.code].enq || "");

      const head = document.createElement("div");
      head.className = "subject-head";
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      head.setAttribute("aria-expanded", State.isOpen(sub.code) ? "true" : "false");
      head.innerHTML = `
        <div class="subject-head-text">
          <div class="subject-title${isSelected ? " subject-title-colored" : ""}" style="color:${isSelected ? color : "inherit"}">${esc(sub.name)} <span class="badge badge-ead${hasEAD ? "" : " badge-ead-hidden"}">EAD</span></div>
          <div class="subject-code">
            <span class="subject-code-text">${esc(sub.code)}</span>
            <span class="turma-chip${isSelected ? "" : " chip-empty"}">
              <svg class="turma-chip-bg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <rect x="4" y="4" width="92" height="92" rx="22" ry="22" fill="none" stroke="currentColor" stroke-width="7"/>
              </svg>
              <span class="turma-chip-text">${isSelected ? esc(selected[sub.code].turma) : ""}</span><span class="turma-chip-star other-campus">${isSelected && selected[sub.code].slots && selected[sub.code].slots.some(s => s.otherCampus) ? "*" : ""}</span>
            </span>
            <span class="t-res res-inline${isSelected ? " t-res-" + (selected[sub.code].res || "").toLowerCase().replace(/\s+/g, "-") : ""}">${isSelected ? esc(selected[sub.code].res || "-") : ""}</span>
            <span class="t-vagas vagas-inline">${isSelected ? esc(vagasLabel(selected[sub.code])) : ""}</span>
          </div>
          <div class="subject-prof">${isSelected ? esc(selected[sub.code].prof || "-") : ""}</div>
        </div>
        <div class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg></div>`;
      const toggleOpen = () => {
        State.toggleOpen(sub.code);
        renderSubjectList();
      };
      head.onclick = toggleOpen;
      head.onkeydown = (e) => {
        if (e.target !== head) return;
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          toggleOpen();
        }
      };
      div.appendChild(head);

      /* Elementos do cabeçalho (ao lado/embaixo do código da matéria) que
         o hover numa turma da lista abaixo atualiza temporariamente —
         ver setHeaderInfo() e o onpointerenter/onpointerleave de cada
         .turma-opt logo mais abaixo. Não muda o tamanho de nada, só o
         conteúdo desses três elementos. */
      const turmaChipEl = head.querySelector(".turma-chip");
      const turmaChipTextEl = head.querySelector(".turma-chip-text");
      const turmaChipStarEl = head.querySelector(".turma-chip-star");
      const resInlineEl = head.querySelector(".t-res.res-inline");
      const vagasInlineEl = head.querySelector(".t-vagas.vagas-inline");
      const profLineEl = head.querySelector(".subject-prof");
      const eadBadgeEl = head.querySelector(".badge-ead");
      function setHeaderInfo(turma, res, prof, hasOtherCampus, vagas, ead) {
        if (turmaChipTextEl) turmaChipTextEl.textContent = turma || "";
        if (turmaChipEl) turmaChipEl.classList.toggle("chip-empty", !turma);
        if (turmaChipStarEl) turmaChipStarEl.textContent = hasOtherCampus ? "*" : "";
        if (resInlineEl) {
          resInlineEl.textContent = res || "";
          resInlineEl.className = "t-res res-inline" + (res ? " t-res-" + res.toLowerCase().replace(/\s+/g, "-") : "");
        }
        if (vagasInlineEl) vagasInlineEl.textContent = vagas || "";
        if (profLineEl) profLineEl.textContent = prof || "";
        if (eadBadgeEl) eadBadgeEl.classList.toggle("badge-ead-hidden", !ead);
      }
      const baseTurma = isSelected ? selected[sub.code].turma : "";
      const baseRes = isSelected ? (selected[sub.code].res || "-") : "";
      const baseProf = isSelected ? (selected[sub.code].prof || "-") : "";
      const baseHasOtherCampus = isSelected && !!(selected[sub.code].slots && selected[sub.code].slots.some(s => s.otherCampus));
      const baseVagas = isSelected ? vagasLabel(selected[sub.code]) : "";
      const restoreHeaderInfo = () => setHeaderInfo(baseTurma, baseRes, baseProf, baseHasOtherCampus, baseVagas, hasEAD);


      const isTwoCol = compactOn && sub.turmas.length > 8;
      const tp = document.createElement("div");
      tp.className = "turma-panel" + (isTwoCol ? " two-col" : "");
      // No modo compacto, a info da turma ativa não entra "no meio" do
      // fluxo (bagunçaria o alinhamento das colunas) — fica guardada aqui
      // e é adicionada só uma vez, no fim, depois de todas as turmas.
      let bottomInfoHtml = null;

      // Fixar (pin) existe nos dois modos (compacto e normal) e usa o
      // mesmo estado — fixar/desafixar em um modo reflete no outro. As
      // fixadas vêm primeiro, na ordem em que foram fixadas; o resto
      // mantém a ordem original entre si.
      let turmasToRender = sub.turmas;
      {
        const pinOrder = State.getPinnedOrder(sub.code);
        if (pinOrder.length) {
          const pinnedSet = new Set(pinOrder);
          const pinnedTurmas = pinOrder.map(tc => sub.turmas.find(t => t.turma === tc)).filter(Boolean);
          const rest = sub.turmas.filter(t => !pinnedSet.has(t.turma));
          turmasToRender = [...pinnedTurmas, ...rest];
        }
      }

      // Ícones "pin-angle" / "pin-angle-fill" dos Bootstrap Icons
      // (https://icons.getbootstrap.com/icons/pin-angle/), via SVG
      // Repo. Bootstrap Icons é licenciado sob MIT (Copyright (c)
      // 2019-2024 The Bootstrap Authors) — aviso de licença/atribuição
      // mantido aqui, junto do uso do ícone. A versão outline é usada
      // quando a turma NÃO está fixada; ao fixar (pressed), troca pra
      // versão preenchida (miolo com cor). Usado nos dois modos
      // (compacto e normal).
      const PIN_PATH_OUTLINE = "M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146zm.122 2.112v-.002.002zm0-.002v.002a.5.5 0 0 1-.122.51L6.293 6.878a.5.5 0 0 1-.511.12H5.78l-.014-.004a4.507 4.507 0 0 0-.288-.076 4.922 4.922 0 0 0-.765-.116c-.422-.028-.836.008-1.175.15l5.51 5.509c.141-.34.177-.753.149-1.175a4.924 4.924 0 0 0-.192-1.054l-.004-.013v-.001a.5.5 0 0 1 .12-.512l3.536-3.535a.5.5 0 0 1 .532-.115l.096.022c.087.017.208.034.344.034.114 0 .23-.011.343-.04L9.927 2.028c-.029.113-.04.23-.04.343a1.779 1.779 0 0 0 .062.46z";
      const PIN_PATH_FILLED = "M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z";
      const pinIcon = (filled) => `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="${filled ? PIN_PATH_FILLED : PIN_PATH_OUTLINE}"></path></svg>`;

      turmasToRender.forEach(t => {
        const slots = parseHorario(t.h);
        const optDiv = document.createElement("div");
        const isActive = isSelected && selected[sub.code].turma === t.turma;
        const isPinned = State.isPinned(sub.code, t.turma);
        optDiv.className = "turma-opt" + (isActive ? " active" : "") + (isPinned ? " pinned" : "");
        const hasOther = slots.some(s => s.otherCampus);

        if (compactOn) {
          /* Modo compacto: o botão vira um controle de até 3 partes:
               1) "i" — só existe na turma ATIVA da matéria (nas demais
                  nem entra no DOM, deixando o texto da turma ocupar
                  mais espaço à esquerda/direita).
               2) turma (.t-mid) — a maior parte do botão, mostrando só
                  o código da turma (sem o prefixo "Turma", em 1 ou 2
                  colunas) pra sobrar espaço pra prioridade de curso
                  (t.prio), exibida ao lado em tom apagado e cortada
                  com "…" se não couber (ver .t-prio-compact no CSS).
                  Quando a turma vira a ativa, a prioridade some de vez
                  no modo de 2 colunas e só parcialmente no de 1 coluna
                  (sobra menos espaço com os botões "i"/pin visíveis,
                  então o texto trunca mais, mas continua aparecendo).
                  Clique normal seleciona; se já estiver selecionada, o
                  hover fica vermelho e o clique nesse estado REMOVE —
                  substitui o antigo botão "✕". Se a turma estiver
                  fixada (pin) e não for a ativa, mostra por cima um
                  indicativo (badge) não-clicável de que ela está
                  fixada — ver .t-pin-indicator no CSS.
               3) pin — botão de verdade (clicável) só existe na turma
                  ATIVA, mesma regra do "i". */
          // pinIcon() / PIN_PATH_OUTLINE / PIN_PATH_FILLED: definidos acima
          // do forEach, compartilhados com o modo normal.
          const turmaLabel = esc(t.turma);
          // Prioridade de curso: fica ao lado do código da turma, num
          // tom apagado, o mais compacta possível (ellipsis se não
          // couber). Quando a turma é selecionada some de vez no modo
          // de 2 colunas (menos espaço sobrando) e só parcialmente no
          // de 1 coluna (o espaço reservado pros botões "i"/pin some
          // menos texto, então o ellipsis corta menos).
          const prioText = (t.prio && t.prio !== "-") ? esc(t.prio) : "";
          const showPrio = !!prioText && !(isActive && isTwoCol);
          optDiv.innerHTML = `
            ${isActive ? `<button type="button" class="t-info-btn" title="Ver informações da turma" aria-label="Ver informações da turma" aria-expanded="${State.isInfoOpen(sub.code) ? "true" : "false"}">i</button>` : ""}
            <div class="t-mid" role="button" tabindex="0" aria-pressed="${isActive ? "true" : "false"}" title="${isActive ? "Remover turma" : "Selecionar turma"}">
              <div class="t-turma">${turmaLabel} ${hasOther ? '<span class="other-campus">*</span>' : ""}</div>
              ${showPrio ? `<div class="t-prio-compact" title="Prioridade - Curso: ${prioText}">${prioText}</div>` : ""}
              ${(!isActive && isPinned) ? `<span class="t-pin-indicator" title="Turma fixada" aria-hidden="true">${pinIcon(true)}</span>` : ""}
            </div>
            ${isActive ? `<button type="button" class="t-pin-btn${isPinned ? " pinned" : ""}" title="${isPinned ? "Desafixar turma" : "Fixar turma no topo"}" aria-label="${isPinned ? "Desafixar turma" : "Fixar turma no topo"}" aria-pressed="${isPinned ? "true" : "false"}">
              ${pinIcon(isPinned)}
            </button>` : ""}
          `;
          const midEl = optDiv.querySelector(".t-mid");
          const infoBtn = optDiv.querySelector(".t-info-btn");
          const pinBtn = optDiv.querySelector(".t-pin-btn");
          const selectOrRemove = () => {
            if (isActive) State.removeSubject(sub.code);
            else State.selectTurma(sub, t, slots);
            State.setPreview(null); // limpa prévia residual (relevante em toque)
            renderAll();
          };
          midEl.onclick = selectOrRemove;
          midEl.onkeydown = (e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
              e.preventDefault();
              selectOrRemove();
            }
          };
          if (infoBtn) infoBtn.onclick = () => { State.toggleInfo(sub.code); renderAll(); };
          if (pinBtn) pinBtn.onclick = () => { State.togglePin(sub.code, t.turma); renderSubjectList(); };
        } else {
          optDiv.setAttribute("role", "button");
          optDiv.setAttribute("tabindex", "0");
          optDiv.setAttribute("aria-pressed", isActive ? "true" : "false");
          optDiv.innerHTML = `
            ${isActive ? `<button type="button" class="t-info-btn" title="Ver informações da turma" aria-label="Ver informações da turma" aria-expanded="${State.isInfoOpen(sub.code) ? "true" : "false"}">i</button>` : ""}
            <div class="t-left">
              <div class="t-turma">Turma ${esc(t.turma)} ${hasOther ? '<span class="other-campus">*</span>' : ""}${(!isActive && isPinned) ? `<span class="t-pin-indicator" title="Turma fixada" aria-hidden="true">${pinIcon(true)}</span>` : ""}</div>
              <div class="t-prof">${esc(t.prof)}</div>
              <div class="t-meta"><span class="t-res t-res-${(t.res || "").toLowerCase().replace(/\s+/g, "-")}">${esc(t.res || "-")}</span>${vagasLabel(t) ? ` <span class="t-vagas">${esc(vagasLabel(t))}</span>` : ""} &middot; ${esc(t.prio || "-")}</div>
            </div>
            ${isActive ? `<button type="button" class="t-pin-btn${isPinned ? " pinned" : ""}" title="${isPinned ? "Desafixar turma" : "Fixar turma no topo"}" aria-label="${isPinned ? "Desafixar turma" : "Fixar turma no topo"}" aria-pressed="${isPinned ? "true" : "false"}">${pinIcon(isPinned)}</button>` : ""}
            ${isActive ? '<button class="t-remove" title="Remover">✕</button>' : ""}
          `;
          const activate = (e) => {
            const target = e && e.target;
            if (target && target.closest && target.closest(".t-pin-btn")) {
              State.togglePin(sub.code, t.turma);
              renderSubjectList();
              return;
            } else if (target && target.closest && target.closest(".t-remove")) {
              State.removeSubject(sub.code);
            } else if (target && target.closest && target.closest(".t-info-btn")) {
              State.toggleInfo(sub.code);
            } else {
              State.selectTurma(sub, t, slots);
            }
            State.setPreview(null); // limpa prévia residual (relevante em toque)
            renderAll();
          };
          optDiv.onclick = activate;
          optDiv.onkeydown = (e) => {
            if (e.target !== optDiv) return; // o botão "Remover" nativo já cuida de si mesmo
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
              e.preventDefault();
              activate(e);
            }
          };
        }
        /* pointerenter em vez de mouseenter: assim dá pra checar o
           pointerType de cada evento (mouse/pen vs touch) em vez de
           decidir uma vez só se o aparelho "tem hover" — cobre também
           iPad com mouse/trackpad conectado. A limpeza do preview (ao
           sair) não fica mais no pointerleave deste item: veja o vigia
           global logo abaixo, mais confiável. Vale pra linha inteira nos
           dois modos (não interfere com os cliques, que são tratados
           separadamente acima). */
        optDiv.onpointerenter = (e) => {
          if (e.pointerType === "touch") return;
          if (isActive) {
            setLinkedHover(sub.code, true);
            // Turma já selecionada não usa prévia (ela já está "aplicada" na
            // grade) — mas se o mouse veio rápido de cima de outra turma
            // (não selecionada) que tinha deixado uma prévia verde/vermelha
            // ativa, essa prévia ficava presa na grade porque este ramo
            // nunca a limpava. Limpa aqui, sempre que entra numa ativa.
            if (State.getPreview()) {
              State.setPreview(null);
              renderGridPreviewOnly();
            }
          } else {
            const conflict = wouldConflict(slots, sub.code);
            State.setPreview({ slots, conflict });
            renderGridPreviewOnly();
          }
          setHeaderInfo(t.turma, t.res || "-", t.prof || "-", hasOther, vagasLabel(t), /\bead\b/i.test(t.enq || ""));
        };
        optDiv.onpointerleave = (e) => {
          if (e.pointerType === "touch") return;
          if (isActive) setLinkedHover(sub.code, false);
          restoreHeaderInfo();
        };
        tp.appendChild(optDiv);

        if (isActive && State.isInfoOpen(sub.code)) {
          const infoHtml = `
            <div><b>Horário:</b> ${horarioDisplay(t.h)}</div>
            <div><b>Professor:</b> ${esc(t.prof || "-")}</div>
            <div><b>Enquadramento:</b> ${esc(t.enq || "-")} &middot; <b>Reserva:</b> ${esc(t.res || "-")}</div>
            <div><b>Vagas Total:</b> ${esc(t.vt || "-")} &middot; <b>Vagas Calouros:</b> ${esc(t.vc || "-")}</div>
            <div><b>Prioridade - Curso:</b> ${esc(t.prio || "-")}</div>
            <div><b>Optativa:</b> ${esc(t.opt || "-")}</div>
          `;
          if (compactOn) {
            bottomInfoHtml = infoHtml; // só uma turma por matéria pode estar ativa
          } else {
            const info = document.createElement("div");
            info.className = "turma-info";
            info.innerHTML = infoHtml;
            tp.appendChild(info);
          }
        }
      });

      if (bottomInfoHtml) {
        const info = document.createElement("div");
        info.className = "turma-info";
        info.innerHTML = bottomInfoHtml;
        tp.appendChild(info);
      }

      div.appendChild(tp);
      subjectListEl.appendChild(div);
    });
    if (subjectListEl.children.length === 0) {
      subjectListEl.innerHTML = `<div class="empty-state">Nenhuma disciplina encontrada.</div>`;
    }
    // Restaura a posição de rolagem de antes do rebuild (ver comentário no
    // início da função). Precisa ser depois de todo o conteúdo já estar de
    // volta no DOM, senão o scrollHeight ainda não reflete a lista cheia.
    subjectListEl.scrollTop = prevScrollTop;
  }

  /* ============== CONFLITOS ============== */
  function computeOccupancy(ignoreCode) {
    const occ = {};
    Object.values(State.getSelected()).forEach(sel => {
      if (ignoreCode && sel.code === ignoreCode) return;
      sel.slots.forEach(s => {
        const key = s.day + "-" + s.code;
        if (!occ[key]) occ[key] = [];
        occ[key].push(sel.code);
      });
    });
    return occ;
  }
  function computeConflictCodes(occ) {
    occ = occ || computeOccupancy();
    const conflictCodes = new Set();
    Object.values(occ).forEach(arr => {
      if (arr.length > 1) arr.forEach(c => conflictCodes.add(c));
    });
    return conflictCodes;
  }

  /* ============== RENDER GRID ============== */
  const gridTable = document.getElementById("gridTable");

  function baseGridHTML(occ) {
    occ = occ || computeOccupancy();
    const selected = State.getSelected();
    let html = `<caption class="visually-hidden">Grade horária semanal — as linhas são os horários de aula e as colunas os dias da semana; cada célula mostra as disciplinas alocadas naquele horário.</caption>`;
    html += "<thead><tr><th scope=\"col\" style='width:70px;'>Aula</th>";
    DAYS.forEach(d => html += `<th scope="col"><span class="day-full">${esc(d.label)}</span><span class="day-med">${esc(d.label.slice(0, 3))}</span><span class="day-abbr">${esc(d.label.slice(0, 1))}</span></th>`);
    html += "</tr></thead><tbody>";

    let lastTurno = null;
    AULAS.forEach((a) => {
      const sepRow = lastTurno && lastTurno !== a.turno;
      lastTurno = a.turno;
      html += `<tr ${sepRow ? 'class="sep-row"' : ""}>`;
      html += `<td class="time-col" role="rowheader">${esc(a.code)}<br>${esc(a.start)}–${esc(a.end)}</td>`;
      DAYS.forEach(d => {
        const key = d.n + "-" + a.code;
        const occupants = occ[key] || [];
        html += `<td data-day="${d.n}" data-aula="${esc(a.code)}">`;
        if (occupants.length) {
          occupants.forEach((code, i) => {
            const sel = selected[code];
            const isConflict = occupants.length > 1;
            const widthPct = 100 / occupants.length;
            const leftPct = i * widthPct;
            const slotInfo = sel.slots.find(s => s.day === d.n && s.code === a.code);
            const roomPlain = slotInfo ? slotInfo.room : "";
            const roomHtml = slotInfo
              ? (slotInfo.otherCampus ? `<span class="b-room other">${esc(slotInfo.room)}*</span>` : esc(slotInfo.room))
              : "";
            const fullTitle = turmaTooltip(sel, sel);
            const ariaLabel = esc(
              `${d.label}, ${a.code} (${a.start}–${a.end}): ${sel.code} — Turma ${sel.turma}` +
              (roomPlain ? `, sala ${roomPlain}${slotInfo && slotInfo.otherCampus ? " (outra sede)" : ""}` : "") +
              (isConflict ? " — conflito de horário" : "")
            );
            html += `<div class="cell-block ${isConflict ? "conflict" : ""}" data-code="${esc(sel.code)}" role="button" tabindex="0" style="background:${sel.color};left:calc(2px + ${leftPct}%);width:calc(${widthPct}% - 4px);" title="${fullTitle}" aria-label="${ariaLabel}">
              <div class="b-name">${esc(sel.code)}</div>
              <div class="b-sub">T${esc(sel.turma)} ${roomHtml}</div>
            </div>`;
          });
        }
        html += `</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody>";
    return html;
  }
  function renderGrid(occ) {
    gridTable.innerHTML = baseGridHTML(occ);
  }

  /* Clique (ou Enter/Espaço) em um bloco de aula na grade remove a disciplina da seleção */
  function removeFromCellBlock(block) {
    const code = block.dataset.code;
    if (!code || !State.isSelected(code)) return;
    State.removeSubject(code);
    renderAll();
    toast(`${code} removida — Ctrl+Z para desfazer.`);
  }
  gridTable.addEventListener("click", (e) => {
    const block = e.target.closest(".cell-block");
    if (!block) return;
    removeFromCellBlock(block);
  });
  gridTable.addEventListener("keydown", (e) => {
    const block = e.target.closest(".cell-block");
    if (!block) return;
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      removeFromCellBlock(block);
    }
  });

  /* Vigia global do preview: em vez de confiar em algum evento específico
     de "saída" disparar (pointerleave de item, de container, etc. — que
     na prática falhava em alguns casos, deixando o preview preso mesmo
     sem mouse em cima de nada), checa a cada movimento do mouse em
     QUALQUER lugar da página se o ponteiro ainda está sobre uma
     .turma-opt. Se não estiver e ainda houver preview ativo, limpa.
     Isso garante que o preview nunca fica "grudado". */
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    if (!State.getPreview()) return;
    if (e.target.closest && e.target.closest(".turma-opt")) return;
    State.setPreview(null);
    renderGridPreviewOnly();
  });
  /* E se o mouse sair da janela/documento inteiro (sem gerar mais
     pointermove dentro dela), garante a limpeza também. */
  document.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch") return;
    if (!State.getPreview()) return;
    State.setPreview(null);
    renderGridPreviewOnly();
  });

  /* ============== HOVER CRUZADO (lista ⇄ grade) ==============
     Passar o mouse num bloco da grade destaca a matéria correspondente
     na lista (mesmo visual de hover da lista), e vice-versa — sem
     inventar um estilo novo, só reaplicando o hover já existente de
     cada lado no elemento correspondente do outro lado. */
  function setLinkedHover(code, on) {
    if (!code) return;
    subjectListEl.querySelectorAll(`.subject[data-code="${CSS.escape(code)}"] .subject-head`)
      .forEach(el => el.classList.toggle("hover-linked", on));
    gridTable.querySelectorAll(`.cell-block[data-code="${CSS.escape(code)}"]`)
      .forEach(el => el.classList.toggle("hover-linked", on));
  }
  /* pointerover/pointerout em vez de mouseover/mouseout, ignorando
     pointerType "touch" — mesmo raciocínio do preview: funciona com
     mouse/trackpad em qualquer aparelho (inclusive iPad com mouse
     conectado), e nunca gruda em toque puro. */
  gridTable.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const block = e.target.closest(".cell-block");
    if (!block) return;
    setLinkedHover(block.dataset.code, true);
  });
  gridTable.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    const block = e.target.closest(".cell-block");
    if (!block) return;
    if (block.contains(e.relatedTarget)) return;
    setLinkedHover(block.dataset.code, false);
  });
  subjectListEl.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    // Só conta como hover cruzado o cabeçalho da matéria (hover na matéria
    // inteira) ou a turma-opt já ativa/selecionada — turmas não selecionadas
    // ficam de fora, senão passar o mouse por qualquer turma da lista
    // acenderia o mesmo destaque na grade.
    const trigger = e.target.closest(".subject-head, .turma-opt.active");
    if (!trigger) return;
    const subject = trigger.closest(".subject");
    if (!subject) return;
    setLinkedHover(subject.dataset.code, true);
  });
  subjectListEl.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    const trigger = e.target.closest(".subject-head, .turma-opt.active");
    if (!trigger) return;
    const subject = trigger.closest(".subject");
    if (!subject) return;
    if (trigger.contains(e.relatedTarget)) return;
    setLinkedHover(subject.dataset.code, false);
  });

  /* A mini-grade já resolve o preview sozinha dentro de renderMiniGrid()
     (lendo o State a cada desenho), então só precisamos redesenhá-la. */
  function renderMiniGridPreviewOnly() {
    renderMiniGrid();
  }

  /* Re-render apenas para aplicar/remover overlay de preview sem reconstruir
     tudo (rápido no hover) */
  function renderGridPreviewOnly() {
    gridTable.querySelectorAll(".cell-preview").forEach(el => el.remove());
    const previewSlots = State.getPreview();
    if (!previewSlots) return;
    previewSlots.slots.forEach(s => {
      const td = gridTable.querySelector(`td[data-day="${s.day}"][data-aula="${s.code}"]`);
      if (!td) return;
      const div = document.createElement("div");
      div.className = "cell-preview " + (previewSlots.conflict ? "pv-conflict" : "pv-ok");
      td.appendChild(div);
    });
    renderMiniGridPreviewOnly();
  }

  /* ============== STATS + BANNER ============== */
  function renderStats(occ) {
    const statsBar = document.getElementById("statsBar");
    const conflictBanner = document.getElementById("conflictBanner");
    const selected = State.getSelected();
    const count = State.countSelected();
    let totalAulas = 0;
    Object.values(selected).forEach(s => totalAulas += s.slots.length);
    const conflicts = computeConflictCodes(occ);

    const totalHoras = Math.round((totalAulas * 50) / 60);

    statsBar.innerHTML = `
      <div><b>${count}</b> disciplina(s) selecionada(s)</div>
      <div><b>${totalAulas}</b> aulas semanais alocadas</div>
      <div class="stat-with-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline></svg><b>${totalHoras}</b> horas semanais</div>
      <div>${conflicts.size > 0 ? `<b style="color:var(--danger)">${conflicts.size}</b> em conflito` : `<b style="color:var(--ok)">Sem conflitos</b>`}</div>
    `;

    if (conflicts.size > 0) {
      const names = [...conflicts].map(c => selected[c] ? esc(selected[c].code) + " (" + esc(selected[c].name) + ")" : esc(c));
      conflictBanner.innerHTML = "<b>Conflito de horário detectado</b> entre: " + names.join(", ");
      conflictBanner.classList.add("show");
    } else {
      conflictBanner.classList.remove("show");
    }
  }

  /* ============== LEGEND ============== */
  function renderLegend() {
    const legend = document.getElementById("legend");
    const items = Object.values(State.getSelected());
    if (!items.length) { legend.innerHTML = ""; return; }
    legend.innerHTML = items.map(s =>
      `<div class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${esc(s.code)} — ${esc(s.name)} (T${esc(s.turma)})</div>`
    ).join("");
  }

  function updateUndoButton() {
    const btn = document.getElementById("btnUndo");
    if (btn) btn.disabled = !State.canUndo();
    const rbtn = document.getElementById("btnRedo");
    if (rbtn) rbtn.disabled = !State.canRedo();
  }

  /* ============== MINI-PRÉVIA DA GRADE (celular) ==============
     Espelha a grade real em miniatura (uma célula por aula x dia, sem
     texto): verde onde há uma disciplina alocada, vermelho quando dois ou
     mais horários colidem na mesma célula. A última matéria escolhida
     aparece em azul para ficar fácil de achar — a não ser que ela própria
     tenha algum conflito (em qualquer horário seu), caso em que todas as
     suas células ficam vermelhas, não só a que colide. Preenche o canto
     vazio do cabeçalho no celular, quando a barra de ferramentas quebra
     de linha. */
  function renderMiniGrid(occ) {
    const miniGrid = document.getElementById("miniGrid");
    if (!miniGrid) return;
    occ = occ || computeOccupancy();
    const lastCode = State.getLastSelected();
    const conflictCodes = computeConflictCodes(occ);
    const lastHasConflict = !!(lastCode && conflictCodes.has(lastCode));
    /* Preview (hover na lista) resolvido aqui também, junto com o resto:
       um mapa "dia-aula" -> "ok"/"conflict" pros slots da turma em hover.
       Assim a mini-grade nunca fica com preview "preso": toda vez que ela
       é redesenhada (por hover ou por qualquer outro motivo), a classe de
       preview reflete o State atual, nunca uma classe deixada por uma
       célula antiga que já nem existe mais. */
    const previewSlots = State.getPreview();
    const previewMap = {};
    if (previewSlots) {
      previewSlots.slots.forEach(s => {
        previewMap[s.day + "-" + s.code] = previewSlots.conflict ? "mini-preview-conflict" : "mini-preview-ok";
      });
    }
    let html = "";
    AULAS.forEach(a => {
      DAYS.forEach(d => {
        const occupants = occ[d.n + "-" + a.code] || [];
        let cls = "mini-cell";
        if (occupants.length > 1) {
          cls += " mini-conflict";
        } else if (occupants.length === 1) {
          const code = occupants[0];
          if (code === lastCode) {
            cls += lastHasConflict ? " mini-conflict" : " mini-last";
          } else {
            cls += " mini-filled";
          }
        }
        const previewCls = previewMap[d.n + "-" + a.code];
        if (previewCls) cls += " " + previewCls;
        html += `<div class="${cls}" data-day="${d.n}" data-aula="${a.code}"></div>`;
      });
    });
    miniGrid.style.gridTemplateColumns = `repeat(${DAYS.length}, 1fr)`;
    miniGrid.style.gridTemplateRows = `repeat(${AULAS.length}, 1fr)`;
    miniGrid.innerHTML = html;
  }

  function renderAll() {
    const occ = computeOccupancy(); // calculado 1x aqui e reaproveitado abaixo
    renderSubjectList(occ);
    renderGrid(occ);
    renderStats(occ);
    renderLegend();
    updateUndoButton();
    renderMiniGrid(occ);
  }

  /* ============== TOAST ============== */
  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  /* ============== COPY / PASTE / LIMPAR ==============
     Extraídas em funções nomeadas (em vez de ficarem só dentro do
     onclick de cada botão) porque agora também são disparadas pelos
     atalhos de teclado (Ctrl+C, Ctrl+V, Delete) mais abaixo — assim os
     botões e os atalhos chamam exatamente a mesma lógica. */
  async function doCopySelection() {
    const items = Object.values(State.getSelected());
    if (!items.length) { toast("Nada selecionado para copiar."); return; }
    const lines = items.map(s => `${s.code}, ${s.turma}`);
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("Seleção copiada para a área de transferência.");
    } catch (e) {
      toast("Não foi possível copiar automaticamente.");
    }
  }

  async function doPasteSelection() {
    try {
      const text = await navigator.clipboard.readText();
      const pairRe = /([A-Za-z]{2,}\d[A-Za-z0-9]*)\s*,\s*([A-Za-z]*\d+[A-Za-z0-9]*)/g;
      const newSelected = {};
      const pasteCodes = [];
      let found = 0, notFound = [];
      let m;
      while ((m = pairRe.exec(text)) !== null) {
        const code = m[1].toUpperCase();
        const turmaCode = m[2].toUpperCase();
        const label = `${code}, ${turmaCode}`;
        const sub = DATA.find(d => d.code.toUpperCase() === code);
        if (!sub) { notFound.push(label); continue; }
        const t = sub.turmas.find(tt => tt.turma.toUpperCase() === turmaCode);
        if (!t) { notFound.push(label); continue; }
        const slots = parseHorario(t.h);
        const color = subjectColor(sub.code, pasteCodes);
        pasteCodes.push(sub.code);
        newSelected[sub.code] = {
          code: sub.code, name: sub.name, turma: t.turma, prof: t.prof, h: t.h, slots, color,
          enq: t.enq, vt: t.vt, vc: t.vc, res: t.res, prio: t.prio, opt: t.opt
        };
        found++;
      }
      if (found === 0) { toast("Nenhuma turma reconhecida na área de transferência."); return; }
      State.replaceSelection(newSelected);
      renderAll();
      toast(notFound.length ? `${found} turma(s) coladas. ${notFound.length} não encontrada(s).` : `${found} turma(s) coladas com sucesso.`);
    } catch (e) {
      toast("Erro ao colar: verifique se copiou os dados corretos.");
    }
  }

  function doClearAll() {
    if (State.countSelected() === 0) return;
    if (confirm("Tem certeza que deseja limpar todas as disciplinas selecionadas?")) {
      State.clearSelection();
      renderAll();
      toast("Seleção limpa.");
    }
  }

  document.getElementById("btnCopy").onclick = doCopySelection;
  document.getElementById("btnPaste").onclick = doPasteSelection;
  document.getElementById("btnClear").onclick = doClearAll;

  /* Botões de template (1/2/3): cada um guarda sua própria grade de
     turmas para o curso atual (ver State.switchTemplate). O botão ativo
     é só um reflexo visual do template atual — não precisa de
     localStorage próprio, porque State.switchCourse() sempre volta pro
     template "1" ao trocar de curso/sede, e updateActiveTemplateBtn()
     é chamado depois de toda troca de curso pra manter a UI sincronizada. */
  const templateBtns = document.querySelectorAll(".template-btn");
  function updateActiveTemplateBtn() {
    const active = State.getActiveTemplate();
    templateBtns.forEach(b => b.classList.toggle("active", b.dataset.template === active));
  }
  templateBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      State.switchTemplate(btn.dataset.template);
      applyDataset(DATA);
      updateActiveTemplateBtn();
      renderAll();
    });
  });

  document.getElementById("btnUndo").onclick = () => {
    if (State.undo()) { renderAll(); toast("Última ação desfeita."); }
  };
  document.getElementById("btnRedo").onclick = () => {
    if (State.redo()) { renderAll(); toast("Ação refeita."); }
  };

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const isTyping = tag === "input" || tag === "textarea" || e.target.isContentEditable;
    const key = e.key.toLowerCase();

    // "/" foca a busca de qualquer lugar da página (padrão tipo GitHub) —
    // checado antes do "isTyping" de propósito, mas só dispara quando o
    // foco NÃO já está em um campo de texto (senão a pessoa nunca
    // conseguiria digitar uma barra dentro da própria busca).
    if (!isTyping && key === "/") {
      e.preventDefault();
      searchBox.focus();
      searchBox.select();
      return;
    }

    if (isTyping) return; // não interceptar digitação normal

    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      if (e.shiftKey) { if (State.redo()) { renderAll(); toast("Ação refeita."); } }
      else { if (State.undo()) { renderAll(); toast("Última ação desfeita."); } }
    } else if ((e.ctrlKey || e.metaKey) && key === "y") {
      e.preventDefault();
      if (State.redo()) { renderAll(); toast("Ação refeita."); }
    } else if ((e.ctrlKey || e.metaKey) && key === "c") {
      // Só assume o Ctrl+C quando não há texto selecionado manualmente na
      // página — senão quebraria o copiar nativo de qualquer trecho que
      // a pessoa tenha selecionado (ex: um texto do rodapé ou das
      // estatísticas), que deve continuar funcionando normalmente.
      const hasTextSelection = !!(window.getSelection && window.getSelection().toString());
      if (!hasTextSelection) {
        e.preventDefault();
        doCopySelection();
      }
    } else if ((e.ctrlKey || e.metaKey) && key === "v") {
      e.preventDefault();
      doPasteSelection();
    } else if (key === "delete") {
      e.preventDefault();
      doClearAll();
    }
  });

  const searchClearBtn = document.getElementById("searchClear");
  function updateSearchClearVisibility() {
    if (searchClearBtn) searchClearBtn.hidden = searchBox.value.length === 0;
  }
  searchBox.oninput = () => { updateSearchClearVisibility(); renderSubjectList(); };
  if (searchClearBtn) {
    searchClearBtn.onclick = () => {
      searchBox.value = "";
      updateSearchClearVisibility();
      renderSubjectList();
      searchBox.focus();
    };
  }
  updateSearchClearVisibility();

  document.getElementById("filterAll").onclick = (e) => { setFilter("all", e.target); };
  document.getElementById("filterSelected").onclick = (e) => { setFilter("selected", e.target); };
  document.getElementById("filterConflict").onclick = (e) => { setFilter("conflict", e.target); };
  function setFilter(mode, btn) {
    const prevMode = State.getFilterMode();
    // Fecha todas as disciplinas expandidas na lista sempre que o filtro
    // muda (em qualquer direção) — evita levar cards abertos (às vezes de
    // disciplinas que nem aparecerão mais no filtro novo) para o novo
    // contexto de visualização.
    if (prevMode !== mode) State.closeAllOpen();
    State.setFilterMode(mode);
    document.querySelectorAll(".filter-row button").forEach(b => {
      b.classList.remove("active");
      b.setAttribute("aria-pressed", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    renderSubjectList();
  }

  /* ============== TEMA (Claro / Escuro / Sistema) ==============
     O tema salvo já é aplicado por um pequeno script inline no <head>
     do index.html (antes deste arquivo carregar), para evitar "flash"
     de tela clara. Aqui só cuidamos da interação com os botões e da
     resposta a mudanças do tema do sistema operacional. */
  const THEME_KEY = "utfpr_theme";
  const mqDark = window.matchMedia("(prefers-color-scheme: dark)");

  const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><line x1="12" y1="1.5" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22.5"></line><line x1="3.5" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="20.5" y2="12"></line><line x1="5.6" y1="5.6" x2="7.4" y2="7.4"></line><line x1="16.6" y1="16.6" x2="18.4" y2="18.4"></line><line x1="16.6" y1="7.4" x2="18.4" y2="5.6"></line><line x1="5.6" y1="18.4" x2="7.4" y2="16.6"></line></svg>';
  const MOON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.6 15.3A8.6 8.6 0 0 1 8.7 3.4a.8.8 0 0 0-1-1A10.2 10.2 0 1 0 21.6 16.3a.8.8 0 0 0-1-1z"></path></svg>';

  // A preferência guardada pode ser "light", "dark" ou "system". O botão
  // deslizante não tem uma posição própria para "sistema": quando a
  // preferência é "system", o slider apenas espelha a aparência atual do
  // SO (mostrando sol ou lua) — mas continua reagindo a mudanças do SO em
  // tempo real, já que a preferência salva continua sendo "system".
  function applyTheme(pref) {
    const isDark = pref === "dark" || (pref === "system" && mqDark.matches);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    const toggle = document.getElementById("themeToggle");
    const thumb = document.getElementById("ttThumb");
    if (thumb) thumb.innerHTML = isDark ? MOON_SVG : SUN_SVG;
    if (toggle) {
      toggle.setAttribute("aria-pressed", isDark ? "true" : "false");
      toggle.title = isDark ? "Modo escuro (clique para mudar para claro)" : "Modo claro (clique para mudar para escuro)";
    }
  }
  function setThemePref(pref) {
    localStorage.setItem(THEME_KEY, pref);
    applyTheme(pref);
  }
  const themeToggleBtn = document.getElementById("themeToggle");
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const isDarkNow = document.documentElement.getAttribute("data-theme") === "dark";
      // Um clique sempre define uma preferência explícita (claro/escuro),
      // saindo do modo "sistema" — que permanece disponível para quem
      // nunca clicou, mas não tem um controle visível dedicado.
      setThemePref(isDarkNow ? "light" : "dark");
    });
  }
  mqDark.addEventListener("change", () => {
    if ((localStorage.getItem(THEME_KEY) || "system") === "system") applyTheme("system");
  });
  applyTheme(localStorage.getItem(THEME_KEY) || "system");

  /* ============== MODO COMPACTO ==============
     Some com professor/reserva/prioridade nas turmas (ver CSS,
     html[data-compact="true"]), deixando só o botão "i" e o número da
     turma — assim cabem mais opções na tela sem precisar rolar tanto
     pra hover/ver a lista inteira. Preferência persistida como o tema;
     o valor inicial já é aplicado antes da 1ª pintura (ver <head>).
     Padrão: ativado (quando não há preferência salva ainda). */
  const COMPACT_KEY = "utfpr_compact";
  function applyCompact(on) {
    if (on) document.documentElement.setAttribute("data-compact", "true");
    else document.documentElement.removeAttribute("data-compact");
    const btn = document.getElementById("compactToggle");
    if (btn) {
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.textContent = on ? "Desativar modo compacto" : "Ativar modo compacto";
    }
  }
  const compactToggleBtn = document.getElementById("compactToggle");
  if (compactToggleBtn) {
    const storedCompact = localStorage.getItem(COMPACT_KEY);
    applyCompact(storedCompact === null ? true : storedCompact === "1");
    compactToggleBtn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-compact") !== "true";
      localStorage.setItem(COMPACT_KEY, next ? "1" : "0");
      applyCompact(next);
      renderAll(); // recalcula o layout de 2 colunas da lista (ver renderSubjectList)
    });
  }

  /* ============== VISIBILIDADE DA MINI-GRADE FLUTUANTE (celular/tablet) ==============
     A mini-grade fica fixa na tela (ver CSS) exceto em dois casos, em que
     ela some para não duplicar informação já visível ou aparecer depois
     de qualquer conteúdo abaixo da tabela (ex.: a seção "O que é..."):
     1) quando a tabela grande JÁ APARECEU um pouco na tela (não no
        primeiro pixel — só depois de uns MINI_GRID_REVEAL_PX de tabela
        visível, pra não sumir a mini-grade cedo demais); e
     2) quando o usuário já rolou para ALÉM da tabela grande — nesse caso
        ela fica travada escondida até o usuário rolar de volta para cima,
        antes da tabela. Isso substitui o antigo "atBottom" (que só
        cobria o fim absoluto da página e deixava a mini-grade reaparecer
        em qualquer conteúdo novo inserido depois da tabela).

     Tablet na vertical tem uma tela bem mais alta que um celular, então a
     lista de disciplinas (que fica empilhada acima da tabela, ver CSS) é
     proporcionalmente mais curta perto do fim da tela — a tabela grande já
     aparece (mesmo que só uma fatia no rodapé da viewport) bem mais cedo
     durante a rolagem da lista, quando na prática ainda falta muito pra
     realmente chegar nela. Usar os mesmos 120px fixos do celular escondia a
     mini-grade cedo demais nesse caso. Por isso, em tablets no modo retrato,
     exigimos uma fatia bem maior da tabela visível (proporcional à altura da
     tela) antes de considerar que ela "já apareceu" e esconder a mini-grade. */
  function initMiniGridVisibility() {
    const miniGrid = document.getElementById("miniGrid");
    const gridWrap = document.querySelector(".grid-wrap");
    if (!miniGrid) return;
    const isTabletPortrait = window.matchMedia("(min-width:701px) and (orientation:portrait)").matches;
    // Celular: 120px fixos (tela curta, a tabela some cedo mesmo).
    // Tablet retrato: 55% da altura da tela — só esconde quando boa parte
    // da tabela já está de fato visível, não só uma tirinha no rodapé.
    const MINI_GRID_REVEAL_PX = isTabletPortrait ? Math.round(window.innerHeight * 0.55) : 120;
    let gridVisible = false;
    let pastGrid = false;
    const applyVisibility = () => {
      miniGrid.classList.toggle("mini-hidden", gridVisible || pastGrid);
    };
    if (gridWrap && "IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          gridVisible = entry.isIntersecting;
          if (entry.isIntersecting) {
            // Tabela voltou a aparecer (rolando pra cima ou pra baixo):
            // ainda não "passamos" dela.
            pastGrid = false;
          } else if (entry.boundingClientRect.bottom < 0) {
            // Tabela ficou inteira acima da tela: rolamos para além dela.
            pastGrid = true;
          }
          applyVisibility();
        });
      }, { threshold: [0, 1.0], rootMargin: `0px 0px -${MINI_GRID_REVEAL_PX}px 0px` });
      io.observe(gridWrap);
    } else {
      applyVisibility();
    }
  }

  /* ============== CARREGAMENTO DE SEDE E CURSO ==============
     Estrutura em duas camadas: data/sedes.json lista as sedes (por
     enquanto só Curitiba), e cada sede tem sua própria pasta
     data/<sede>/ com um manifest.json (catálogo de cursos daquela sede)
     e um data/<sede>/<slug>.json por curso (só o array de disciplinas —
     DAYS, AULAS e PALETTE já vêm de config.js e são iguais pra tudo).
     Trocar de sede recarrega o manifest de cursos daquela sede e carrega
     o primeiro curso dela (ou o último usado nessa sede, se houver). */
  const LAST_SEDE_KEY = "utfpr_sede";
  const sedeSelect = document.getElementById("sedeSelect");
  const courseSelect = document.getElementById("courseSelect");
  let sedeManifest = [];
  let courseManifest = [];
  let currentSede = null;

  function courseKeyFor(sedeSlug) {
    return "utfpr_curso_" + sedeSlug;
  }

  function findSede(slug) {
    return sedeManifest.find(s => s.slug === slug) || null;
  }

  function findCourse(slug) {
    return courseManifest.find(c => c.slug === slug) || null;
  }

  // Aplica no app um array de disciplinas já carregado (troca DATA,
  // dedupe de horários repetidos e reindexação da seleção salva).
  function applyDataset(disciplinas) {
    dedupeHorarios(disciplinas);
    DATA = disciplinas;
    State.pruneAndRefresh((code, sel) => {
      const sub = DATA.find(s => s.code === code);
      if (!sub) return null;
      const t = sub.turmas.find(x => x.turma === sel.turma);
      if (!t) return null;
      return { slots: parseHorario(t.h), color: subjectColor(code) };
    });
  }

  function updateCourseHeader(slug) {
    // O título da aba fica sempre fixo — não reflete mais o curso atual.
    document.title = "MontaHorário UTFPR 2026/2";
  }

  // Busca data/<sede>/<slug>.json e carrega o curso. switching=true indica
  // que já havia um curso carregado antes (troca manual pelo seletor, ou
  // troca de sede), então reseta accordions/desfazer/refazer e mostra um
  // toast ao final.
  async function loadCourse(slug, switching) {
    if (courseSelect) courseSelect.disabled = true;
    try {
      const res = await fetch(`data/${currentSede}/${slug}.json`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const disciplinas = await res.json();
      State.switchCourse(currentSede, slug);
      applyDataset(disciplinas);
      localStorage.setItem(courseKeyFor(currentSede), slug);
      updateCourseHeader(slug);
      updateActiveTemplateBtn();
      renderAll();
      if (switching) toast(`Curso alterado: ${(findCourse(slug) || {}).label || slug}.`);
    } catch (e) {
      toast(`Não foi possível carregar os dados desse curso (${slug}). Confira sua conexão e tente de novo.`);
    } finally {
      if (courseSelect) courseSelect.disabled = false;
    }
  }

  // Busca data/<sede>/manifest.json (catálogo de cursos daquela sede) e
  // carrega o curso inicial dela: o último usado nessa sede (se ainda
  // existir no manifest) ou o primeiro da lista.
  async function loadSedeCourses(sedeSlug, switchingSede) {
    if (sedeSelect) sedeSelect.disabled = true;
    if (courseSelect) courseSelect.disabled = true;

    try {
      const res = await fetch(`data/${sedeSlug}/manifest.json`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      courseManifest = await res.json();
    } catch (e) {
      courseManifest = [];
      toast(`Não foi possível carregar os cursos da sede ${sedeSlug}.`);
    }

    currentSede = sedeSlug;
    localStorage.setItem(LAST_SEDE_KEY, sedeSlug);

    if (courseSelect) {
      courseSelect.innerHTML = courseManifest
        .map(c => `<option value="${esc(c.slug)}">${esc(c.label)}</option>`)
        .join("");
    }

    const savedCourse = localStorage.getItem(courseKeyFor(sedeSlug));
    const initialSlug = (savedCourse && findCourse(savedCourse) && savedCourse)
      || (courseManifest[0] && courseManifest[0].slug);

    if (!initialSlug) {
      toast(`Nenhum curso disponível para a sede ${(findSede(sedeSlug) || {}).label || sedeSlug}.`);
      if (sedeSelect) sedeSelect.disabled = false;
      if (courseSelect) courseSelect.disabled = false;
      return;
    }

    if (courseSelect) courseSelect.value = initialSlug;
    await loadCourse(initialSlug, false);
    if (switchingSede) toast(`Sede alterada: ${(findSede(sedeSlug) || {}).label || sedeSlug}.`);
    if (sedeSelect) sedeSelect.disabled = false;
  }

  if (sedeSelect) {
    sedeSelect.onchange = () => {
      const slug = sedeSelect.value;
      if (slug) loadSedeCourses(slug, true);
    };
  }

  if (courseSelect) {
    courseSelect.onchange = () => {
      const slug = courseSelect.value;
      if (slug) loadCourse(slug, true);
    };
  }

  /* ============== INIT ============== */
  (async function init() {
    try {
      const res = await fetch("data/sedes.json");
      sedeManifest = await res.json();
    } catch (e) {
      sedeManifest = [];
    }

    if (sedeSelect) {
      sedeSelect.innerHTML = sedeManifest
        .map(s => `<option value="${esc(s.slug)}">${esc(s.label)}</option>`)
        .join("");
    }

    const savedSede = localStorage.getItem(LAST_SEDE_KEY);
    const initialSede = (savedSede && findSede(savedSede) && savedSede)
      || (sedeManifest[0] && sedeManifest[0].slug);

    if (!initialSede) {
      toast("Nenhuma sede disponível em data/sedes.json.");
      return;
    }

    if (sedeSelect) sedeSelect.value = initialSede;
    await loadSedeCourses(initialSede, false);
    initMiniGridVisibility();
  })();

  /* ============== EXPORT PARA TESTES (Node) ==============
     Só roda em Node (module.exports não existe no browser), então isso
     nunca afeta o app rodando no navegador. Expõe as funções puras
     (sem DOM) e também o State (seleção de turmas, templates 1/2/3,
     desfazer/refazer) para serem testados isoladamente em test.js — o
     State não toca o DOM diretamente, só localStorage, então funciona
     igual no sandbox de teste. */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseHorario,
      dedupeHorarios,
      hexToRgb,
      colorDistance,
      computeColorMap,
      esc,
      State,
    };
  }
})();
