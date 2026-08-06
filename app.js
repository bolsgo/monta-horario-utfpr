/* app.js — Lógica do MontaHorário UTFPR
   Depende de config.js (DAYS, AULAS, PALETTE). Disciplinas (DATA) são
   carregadas sob demanda via fetch de data/<slug>.json (ver "CARREGAMENTO
   DE CURSO"). Tudo dentro de uma IIFE. */
(function () {
  "use strict";

  // Disciplinas do curso atualmente carregado (preenchido por applyDataset()).
  let DATA = [];

  // Pointer Events em vez de mouse/hover fixo: cobre iPad que ganha/perde
  // mouse depois de carregado. Toque nunca aciona preview/hover cruzado.

  // Remove blocos de horário duplicados (ex: "5T2(CD-108)" repetido) antes
  // de montar os índices, preservando salas com hífen.
  function dedupeHorarios(disciplinas) {
    disciplinas.forEach(disciplina => {
      disciplina.turmas.forEach(turma => {
        if (turma.h) {
          const blocos = turma.h.match(/\d[MTN]\d\s*\([^)]*\)/g);
          if (blocos) {
            turma.h = [...new Set(blocos)].join('-');
          }
        }
      });
    });
  }
  /* ============== ÍNDICE AUXILIAR (derivado de AULAS, de config.js) ============== */
  const AULA_INDEX = {};
  AULAS.forEach((a, i) => { AULA_INDEX[a.code] = i; });

  // Escapa texto antes de inserir no DOM via innerHTML (evita XSS).
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Parser: entrada "5N1(CE-102)-5N2(CE-102)-6M1(*CE-303)-6M2(**CE-303)"
  // asteriscos indicam sede diferente (Ecoville/Neoville)
  const parseHorarioCache = new Map();
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
// Converte "#rrggbb" para {r,g,b}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Distância euclidiana entre duas cores (quanto maior, mais diferentes)
function colorDistance(hexA, hexB) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

// Para cada código (na ordem dada), escolhe a cor da PALETTE mais distante
// das já escolhidas antes dela, maximizando contraste. A ordem é
// preservada entre chamadas, então selecionar/remover matéria não
// embaralha a cor das demais.
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

// Cor de UM código específico, dado o contexto (ordem) das selecionadas.
function subjectColor(code, contextCodes) {
  const selectedCodes = contextCodes || Object.keys(State.getSelected());
  const codes = selectedCodes.includes(code) ? selectedCodes : [...selectedCodes, code];
  return computeColorMap(codes).get(code);
}

  // Estado da aplicação: toda informação mutável (seleção, disciplinas
  // expandidas, filtro ativo, undo/redo, preview) encapsulada aqui. O
  // resto do código só acessa via os métodos abaixo.
  const State = (function () {
    let selected = {};              // {codigo: {..dados da turma escolhida..}}
    let openSubjects = new Set();   // códigos de disciplinas expandidas na lista
    let openInfo = new Set();       // códigos com o painel de detalhes da turma ativa aberto
    // Turmas fixadas (pin, só modo compacto). {codigo: [turma1, turma2, ...]}
    // na ordem de fixação. Não entra no undo/redo nem é persistido.
    let pinned = {};
    let filterMode = "all";         // "all" | "selected" | "conflict" | "pinned"
    let previewSlots = null;        // {slots, conflict} enquanto o mouse está sobre uma turma
    let undoStack = [];
    let redoStack = [];
    // Histórico de undo/redo por template (1/2/3), só em memória (não
    // persiste ao recarregar). Zerado em switchCourse().
    let undoRedoByTemplate = {};
    let lastSelectedCode = null;    // código da última matéria escolhida (destaque azul na mini-grade)
    // A chave de storage inclui slug do curso + template ativo
    // ("..._t1"/"_t2"/"_t3"), já que cada curso tem 3 grades independentes.
    // Trocar de curso/sede sempre volta para o template "1".
    let baseStorageKey = "utfpr_horario_v2";
    let activeTemplate = "1";
    // Chave de storage dos pins, namespaced por sede+curso em switchCourse().
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
    // Migra grade salva na chave antiga (pré-templates) para o template 1,
    // só se ele ainda estiver vazio.
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
      // Remove entradas cujo código/turma não existam mais no dataset e
      // atualiza slots/cor das válidas. Não entra no undo/redo.
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

      // Painel de detalhes da turma ativa expandido. Só exibição — não
      // entra no undo/redo nem é persistido.
      isInfoOpen(code) { return openInfo.has(code); },
      toggleInfo(code) {
        if (openInfo.has(code)) openInfo.delete(code); else openInfo.add(code);
      },

      // Fixar entra no fim da lista de fixadas; desafixar sai de onde estiver.
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

      // Salva a grade atual no template ativo, troca para o template
      // escolhido e carrega a grade salva dele. Accordions/undo-redo são
      // resetados (não fazem sentido entre templates diferentes).
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

      // Troca de curso: aponta o storage para a chave do novo curso
      // (namespaced por sede, evitando colisão de slugs), volta o
      // template para "1" e limpa estado de UI/histórico do curso anterior.
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

  // Monta o tooltip (title nativo) com todos os campos da turma.
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

  // Monta o texto curto de vagas ("Vagas:30" ou "Vagas:30 Cal.:5").
  // Quando vt é "0", exibe "-"; "Cal." só aparece se vc > 0.
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

  // Checa conflito de slots candidatos contra a seleção atual, ignorando um código
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

  // Remove acentos/diacríticos para permitir busca "algebra" encontrar "álgebra"
  function normalizeText(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function renderSubjectList(occ) {
    const q = normalizeText(searchBox.value.trim());
    // A lista é reconstruída (innerHTML="") a cada seleção/remoção; em
    // touch (especialmente iOS) isso zera o scrollHeight e o navegador
    // clampa o scrollTop a 0, fazendo a lista pular pro topo. Guardamos e
    // reaplicamos o scrollTop no fim.
    const prevScrollTop = subjectListEl.scrollTop;
    subjectListEl.innerHTML = "";
    const conflictSet = computeConflictCodes(occ);
    const selected = State.getSelected();
    const filterMode = State.getFilterMode();
    // Modo compacto: painel de turmas com muitas opções vira 2 colunas
    const compactOn = document.documentElement.getAttribute("data-compact") === "true";

    DATA.forEach(sub => {
      const isSelected = State.isSelected(sub.code);
      if (filterMode === "selected" && !isSelected) return;
      if (filterMode === "conflict" && !conflictSet.has(sub.code)) return;
      if (filterMode === "pinned" && State.getPinnedOrder(sub.code).length === 0) return;
      if (q) {
        const hay = normalizeText(sub.code + " " + sub.name + " " + sub.turmas.map(t => t.prof + " " + t.turma).join(" "));
        if (!hay.includes(q)) return;
      }
      const div = document.createElement("div");
      div.className = "subject" + (isSelected ? " selected" : "") + (State.isOpen(sub.code) ? " open" : "");
      div.setAttribute("data-code", sub.code);
      // Usa a MESMA cor já fixada em selected[code].color (ver
      // State.selectTurma) em vez de recalcular: recalcular reordenava as
      // cores das outras matérias selecionadas ao remover uma delas.
      const color = isSelected ? selected[sub.code].color : null;
      // Selo "EAD" (campo "enq"): visível quando a turma selecionada é EAD.
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

      // Elementos do cabeçalho atualizados temporariamente pelo hover numa
      // turma da lista (ver setHeaderInfo() e onpointerenter/onpointerleave abaixo)
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
      // No modo compacto, a info da turma ativa entra só no fim (senão
      // bagunçaria o alinhamento das colunas).
      let bottomInfoHtml = null;

      // Fixadas vêm primeiro (ordem de fixação); resto mantém ordem original.
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

      // Ícones "pin-angle"/"pin-angle-fill" dos Bootstrap Icons
      // (https://icons.getbootstrap.com/icons/pin-angle/), licenciados
      // sob MIT (Copyright (c) 2019-2024 The Bootstrap Authors).
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
          // Modo compacto: botão com até 3 partes:
          // 1) "i" — só na turma ATIVA (info da turma).
          // 2) turma (.t-mid) — código da turma + prioridade (t.prio) ao
          //    lado em tom apagado, truncada com "…" se não couber. Clique
          //    seleciona; se já selecionada, hover fica vermelho e clique remove.
          //    Se fixada e não ativa, mostra badge não-clicável (.t-pin-indicator).
          // 3) pin — clicável só na turma ATIVA.
          const turmaLabel = esc(t.turma);
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
            if (e.target !== optDiv) return; // botão "Remover" já cuida de si mesmo
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
              e.preventDefault();
              activate(e);
            }
          };
        }
        // pointerenter em vez de mouseenter: cobre iPad com mouse/trackpad.
        // A limpeza do preview ao sair fica no vigia global logo abaixo.
        optDiv.onpointerenter = (e) => {
          if (e.pointerType === "touch") return;
          if (isActive) {
            setLinkedHover(sub.code, true);
            // Turma já selecionada não usa prévia, mas limpa uma prévia
            // residual deixada por outra turma sobre a qual o mouse passou antes.
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
          // restoreHeaderInfo() não fica aqui para evitar um "pulo" visual
          // ao mover o mouse entre turmas vizinhas — a restauração acontece
          // só no pointerleave do painel inteiro (tp, abaixo).
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
            bottomInfoHtml = infoHtml;
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

      // pointerleave do painel inteiro (não bubble): dispara só quando o
      // mouse sai de toda a área de turmas da matéria. Aqui o cabeçalho
      // volta a mostrar a turma selecionada.
      tp.onpointerleave = (e) => {
        if (e.pointerType === "touch") return;
        restoreHeaderInfo();
      };

      div.appendChild(tp);
      subjectListEl.appendChild(div);
    });
    if (subjectListEl.children.length === 0) {
      subjectListEl.innerHTML = `<div class="empty-state">Nenhuma disciplina encontrada.</div>`;
    }
    // Restaura a posição de rolagem de antes do rebuild.
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

  // Clique (ou Enter/Espaço) em um bloco de aula na grade remove a disciplina da seleção
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

  // Vigia global do preview: a cada movimento do mouse em qualquer lugar
  // da página, checa se o ponteiro ainda está sobre uma .turma-opt; se não
  // estiver, limpa o preview (evita que fique "grudado").
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    if (!State.getPreview()) return;
    if (e.target.closest && e.target.closest(".turma-opt")) return;
    State.setPreview(null);
    renderGridPreviewOnly();
  });
  // Se o mouse sair da janela/documento inteiro, limpa também.
  document.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch") return;
    if (!State.getPreview()) return;
    State.setPreview(null);
    renderGridPreviewOnly();
  });

  // Hover cruzado (lista ⇄ grade): passar o mouse num bloco da grade
  // destaca a matéria correspondente na lista, e vice-versa.
  function setLinkedHover(code, on) {
    if (!code) return;
    subjectListEl.querySelectorAll(`.subject[data-code="${CSS.escape(code)}"] .subject-head`)
      .forEach(el => el.classList.toggle("hover-linked", on));
    gridTable.querySelectorAll(`.cell-block[data-code="${CSS.escape(code)}"]`)
      .forEach(el => el.classList.toggle("hover-linked", on));
  }
  // pointerover/pointerout ignorando touch (mesmo raciocínio do preview)
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
    // Só conta o cabeçalho da matéria ou a turma-opt já ativa/selecionada
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

  // A mini-grade resolve o preview sozinha dentro de renderMiniGrid()
  function renderMiniGridPreviewOnly() {
    renderMiniGrid();
  }

  // Re-render apenas do overlay de preview, sem reconstruir tudo (rápido no hover)
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
    fitStatsLine();

    if (conflicts.size > 0) {
      const names = [...conflicts].map(c => selected[c] ? esc(selected[c].code) + " (" + esc(selected[c].name) + ")" : esc(c));
      conflictBanner.innerHTML = "<b>Conflito de horário detectado</b> entre: " + names.join(", ");
      conflictBanner.classList.add("show");
    } else {
      conflictBanner.classList.remove("show");
    }
  }

  // Encolhe o font-size do #statsBar até caber em uma linha (modo horizontal).
  function fitStatsLine() {
    const statsBar = document.getElementById("statsBar");
    if (!statsBar) return;
    statsBar.style.fontSize = "";
    if (mqMiniGridActive.matches) return;
    const baseSize = parseFloat(getComputedStyle(statsBar).fontSize);
    if (statsBar.clientWidth > 0 && statsBar.scrollWidth > statsBar.clientWidth) {
      const ratio = statsBar.clientWidth / statsBar.scrollWidth;
      const newSize = Math.max(9, baseSize * ratio * 0.96);
      statsBar.style.fontSize = newSize + "px";
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

  // Media query que espelha a regra CSS que torna .mini-grid visível
  // (ver styles.css). matches===false = display:none (desktop/paisagem).
  const mqMiniGridActive = window.matchMedia("(max-width:980px), (orientation:portrait)");
  // Ao entrar na faixa onde o mini-grid é exibido (resize/rotação), força
  // um render — renderMiniGrid() pulou o rebuild enquanto fora dela.
  mqMiniGridActive.addEventListener("change", () => {
    if (mqMiniGridActive.matches) renderMiniGrid();
    fitStatsLine();
  });

  // Reajusta o font-size das estatísticas ao redimensionar a janela.
  let statsResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(statsResizeTimer);
    statsResizeTimer = setTimeout(fitStatsLine, 100);
  });

  // Células do mini-grid, criadas uma única vez (AULAS/DAYS vêm de
  // config.js e são fixos para todo o app — não mudam ao trocar de
  // curso/sede). Map "dia-aula" -> elemento, reaproveitado em todo render.
  let miniCellEls = null;
  function buildMiniGridCells(miniGrid) {
    const frag = document.createDocumentFragment();
    miniCellEls = new Map();
    AULAS.forEach(a => {
      DAYS.forEach(d => {
        const div = document.createElement("div");
        div.dataset.day = d.n;
        div.dataset.aula = a.code;
        frag.appendChild(div);
        miniCellEls.set(d.n + "-" + a.code, div);
      });
    });
    miniGrid.style.gridTemplateColumns = `repeat(${DAYS.length}, 1fr)`;
    miniGrid.style.gridTemplateRows = `repeat(${AULAS.length}, 1fr)`;
    miniGrid.innerHTML = "";
    miniGrid.appendChild(frag);
  }

  // Mini-prévia da grade (celular): espelha a grade real em miniatura —
  // verde onde há disciplina alocada, vermelho em conflito. A última
  // matéria escolhida aparece em azul (ou vermelho, se tiver conflito).
  function renderMiniGrid(occ) {
    const miniGrid = document.getElementById("miniGrid");
    if (!miniGrid) return;
    // Pula o render caro quando o mini-grid não está visível: display:none
    // no desktop (mqMiniGridActive.matches é false) ou escondido por scroll
    // no mobile (.mini-hidden, que só usa opacity/transform, então o
    // elemento continua no layout). Ambas as checagens são leituras
    // baratas (matchMedia/classList), sem reflow.
    if (!mqMiniGridActive.matches || miniGrid.classList.contains("mini-hidden")) return;
    if (!miniCellEls) buildMiniGridCells(miniGrid);
    occ = occ || computeOccupancy();
    const lastCode = State.getLastSelected();
    const conflictCodes = computeConflictCodes(occ);
    const lastHasConflict = !!(lastCode && conflictCodes.has(lastCode));
    // Preview (hover na lista): mapa "dia-aula" -> "ok"/"conflict"
    const previewSlots = State.getPreview();
    const previewMap = {};
    if (previewSlots) {
      previewSlots.slots.forEach(s => {
        previewMap[s.day + "-" + s.code] = previewSlots.conflict ? "mini-preview-conflict" : "mini-preview-ok";
      });
    }
    // Em vez de reconstruir o innerHTML inteiro a cada hover, só atualiza a
    // classe de cada célula já existente (e só escreve no DOM quando a
    // classe realmente muda) — bem mais barato que recriar ~AULAS×DAYS
    // elementos toda vez.
    AULAS.forEach(a => {
      DAYS.forEach(d => {
        const key = d.n + "-" + a.code;
        const occupants = occ[key] || [];
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
        const previewCls = previewMap[key];
        if (previewCls) cls += " " + previewCls;
        const el = miniCellEls.get(key);
        if (el && el.className !== cls) el.className = cls;
      });
    });
  }

  function renderAll() {
    const occ = computeOccupancy();
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

  // Extraídas em funções nomeadas para serem chamadas tanto pelos botões
  // quanto pelos atalhos de teclado (Ctrl+C, Ctrl+V, Delete) abaixo.
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

  // Botões de template (1/2/3): cada um guarda sua própria grade (ver
  // State.switchTemplate). O botão ativo é só reflexo visual do estado.
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

    // "/" foca a busca (padrão tipo GitHub), só quando não já digitando
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
      // Só assume o Ctrl+C se não há texto selecionado manualmente na
      // página (senão quebraria o copiar nativo desse texto).
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
  // O botão de pin tem um <svg> filho: um clique no ícone faz e.target
  // apontar pro <svg>/<path> em vez do <button>, por isso usa
  // e.currentTarget (sempre o elemento com o listener) em vez de e.target.
  document.getElementById("filterPin").onclick = (e) => { setFilter("pinned", e.currentTarget); };
  function setFilter(mode, btn) {
    const prevMode = State.getFilterMode();
    // Fecha disciplinas expandidas sempre que o filtro muda
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

  // Tema (claro/escuro/sistema): valor salvo já aplicado por script
  // inline no <head> do index.html, para evitar "flash" de tela clara.
  // Aqui só cuidamos da interação com os botões e do tema do SO.
  const THEME_KEY = "utfpr_theme";
  const mqDark = window.matchMedia("(prefers-color-scheme: dark)");

  const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><line x1="12" y1="1.5" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22.5"></line><line x1="3.5" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="20.5" y2="12"></line><line x1="5.6" y1="5.6" x2="7.4" y2="7.4"></line><line x1="16.6" y1="16.6" x2="18.4" y2="18.4"></line><line x1="16.6" y1="7.4" x2="18.4" y2="5.6"></line><line x1="5.6" y1="18.4" x2="7.4" y2="16.6"></line></svg>';
  const MOON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.6 15.3A8.6 8.6 0 0 1 8.7 3.4a.8.8 0 0 0-1-1A10.2 10.2 0 1 0 21.6 16.3a.8.8 0 0 0-1-1z"></path></svg>';

  // Preferência pode ser "light", "dark" ou "system"; no modo "system" o
  // slider só espelha a aparência atual do SO, reagindo a mudanças dele.
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
      // Um clique sempre define uma preferência explícita, saindo do modo "sistema"
      setThemePref(isDarkNow ? "light" : "dark");
    });
  }
  mqDark.addEventListener("change", () => {
    if ((localStorage.getItem(THEME_KEY) || "system") === "system") applyTheme("system");
  });
  applyTheme(localStorage.getItem(THEME_KEY) || "system");

  // Modo compacto: some com professor/reserva/prioridade nas turmas (ver
  // CSS, html[data-compact="true"]), deixando só o "i" e o número da
  // turma. Preferência persistida como o tema. Padrão: ativado.
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

  // Visibilidade da mini-grade flutuante (celular/tablet): some quando a
  // tabela grande já apareceu na tela (depois de MINI_GRID_REVEAL_PX
  // visíveis) ou quando o usuário já rolou para além dela. Em tablet
  // retrato, a tela é bem mais alta, então exige uma fatia maior da
  // tabela (55% da altura) antes de considerar "já apareceu" — usar os
  // 120px fixos do celular escondia a mini-grade cedo demais.
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
    let wasHidden = false;
    const applyVisibility = () => {
      const hidden = gridVisible || pastGrid;
      miniGrid.classList.toggle("mini-hidden", hidden);
      // renderMiniGrid() pula o rebuild enquanto escondido (ver função) —
      // ao reaparecer, força um render pra não mostrar conteúdo velho.
      if (wasHidden && !hidden) renderMiniGrid();
      wasHidden = hidden;
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

  // Carregamento de sede/curso: data/sedes.json lista as sedes; cada sede
  // tem data/<sede>/manifest.json (catálogo de cursos) e um
  // data/<sede>/<slug>.json por curso. Trocar de sede recarrega o
  // manifest e carrega o primeiro curso dela (ou o último usado).
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

  // Export para testes (Node): só roda em Node, nunca afeta o navegador.
  // Expõe funções puras e o State (não toca DOM, só localStorage) para test.js.
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
