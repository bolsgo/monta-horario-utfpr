/* ==================================================================
   app.js — Lógica do MontaHorário UTFPR
   Depende de data.js (DATA, DAYS, AULAS, PALETTE) já carregado antes.
   Tudo fica dentro de uma IIFE: nada aqui vaza para o escopo global,
   exceto o que já vem de data.js.
   ================================================================== */
(function () {
  "use strict";
   /* ============== REMOVEDOR DE DUPLICATAS ==============
     Lê os dados do DATA e remove blocos de horários 
     exatamente iguais antes de montar os índices,
     preservando salas com hífen (ex: CD-108). */
  DATA.forEach(disciplina => {
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
  /* ============== ÍNDICE AUXILIAR (derivado dos dados de data.js) ============== */
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
  function parseHorario(h) {
    if (!h) return [];
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
    return out;
  }
function subjectColor(code) {
    let hash = 0;
    for (let i = 0; i < code.length; i++) {
      // Usando um multiplicador primo (31) para melhor distribuição
      hash = (hash * 31) + code.charCodeAt(i);
      hash = hash & hash; // Converte para inteiro de 32 bits
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
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
    let filterMode = "all";         // "all" | "selected" | "conflict"
    let previewSlots = null;        // {slots, conflict} enquanto o mouse está sobre uma turma
    let undoStack = [];
    let redoStack = [];
    const STORAGE_KEY = "utfpr_horario_v2";

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
        this.save();
      },
      removeSubject(code) {
        this.pushUndo();
        delete selected[code];
        this.save();
      },
      replaceSelection(newSelected) {
        this.pushUndo();
        selected = newSelected;
        this.save();
      },
      clearSelection() {
        this.pushUndo();
        selected = {};
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

      load() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) selected = JSON.parse(raw);
        } catch (e) { /* estado corrompido: ignora e começa vazio */ }
      },
      save() {
        localStorage.setItem(STORAGE_KEY, snapshot());
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

  function renderSubjectList() {
    const q = searchBox.value.trim().toLowerCase();
    subjectListEl.innerHTML = "";
    const conflictSet = computeConflictCodes();
    const selected = State.getSelected();
    const filterMode = State.getFilterMode();

    DATA.forEach(sub => {
      const isSelected = State.isSelected(sub.code);
      if (filterMode === "selected" && !isSelected) return;
      if (filterMode === "conflict" && !conflictSet.has(sub.code)) return;
      if (q) {
        const hay = (sub.code + " " + sub.name + " " + sub.turmas.map(t => t.prof + " " + t.turma).join(" ")).toLowerCase();
        if (!hay.includes(q)) return;
      }
      const div = document.createElement("div");
      div.className = "subject" + (isSelected ? " selected" : "") + (State.isOpen(sub.code) ? " open" : "");
      const color = subjectColor(sub.code);

      const head = document.createElement("div");
      head.className = "subject-head";
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      head.setAttribute("aria-expanded", State.isOpen(sub.code) ? "true" : "false");
      head.innerHTML = `
        <div>
          <div class="subject-title" style="color:${isSelected ? color : "inherit"}">${esc(sub.name)}</div>
          <div class="subject-code">${esc(sub.code)} ${isSelected ? `<span class="badge selected-badge">${esc(selected[sub.code].turma)}</span>` : ""}</div>
        </div>
        <div class="chev" aria-hidden="true">▶</div>`;
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

      const tp = document.createElement("div");
      tp.className = "turma-panel";

      sub.turmas.forEach(t => {
        const slots = parseHorario(t.h);
        const optDiv = document.createElement("div");
        const isActive = isSelected && selected[sub.code].turma === t.turma;
        optDiv.className = "turma-opt" + (isActive ? " active" : "");
        optDiv.setAttribute("role", "button");
        optDiv.setAttribute("tabindex", "0");
        optDiv.setAttribute("aria-pressed", isActive ? "true" : "false");
        const hasOther = slots.some(s => s.otherCampus);
        optDiv.innerHTML = `
          <div class="t-left">
            <div class="t-turma">Turma ${esc(t.turma)} ${hasOther ? '<span class="other-campus">*</span>' : ""}</div>
            <div class="t-prof">${esc(t.prof)}</div>
            <div class="t-meta"><span class="t-res t-res-${(t.res || "").toLowerCase().replace(/\s+/g, "-")}">${esc(t.res || "-")}</span> &middot; ${esc(t.prio || "-")}</div>
          </div>
          ${isActive ? '<button class="t-remove" title="Remover">✕</button>' : ""}
        `;
        const activate = (e) => {
          if (e && e.target && e.target.classList && e.target.classList.contains("t-remove")) {
            State.removeSubject(sub.code);
          } else {
            State.selectTurma(sub, t, slots);
          }
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
        optDiv.onmouseenter = () => {
          const conflict = wouldConflict(slots, sub.code);
          State.setPreview({ slots, conflict });
          renderGridPreviewOnly();
        };
        optDiv.onmouseleave = () => {
          State.setPreview(null);
          renderGridPreviewOnly();
        };
        tp.appendChild(optDiv);

        if (isActive) {
          const info = document.createElement("div");
          info.className = "turma-info";
          info.innerHTML = `
            <div><b>Horário:</b> ${horarioDisplay(t.h)}</div>
            <div><b>Professor:</b> ${esc(t.prof || "-")}</div>
            <div><b>Enquadramento:</b> ${esc(t.enq || "-")} &middot; <b>Reserva:</b> ${esc(t.res || "-")}</div>
            <div><b>Vagas Total:</b> ${esc(t.vt || "-")} &middot; <b>Vagas Calouros:</b> ${esc(t.vc || "-")}</div>
            <div><b>Prioridade - Curso:</b> ${esc(t.prio || "-")}</div>
            <div><b>Optativa:</b> ${esc(t.opt || "-")}</div>
          `;
          tp.appendChild(info);
        }
      });

      div.appendChild(tp);
      subjectListEl.appendChild(div);
    });
    if (subjectListEl.children.length === 0) {
      subjectListEl.innerHTML = `<div class="empty-state">Nenhuma disciplina encontrada.</div>`;
    }
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
  function computeConflictCodes() {
    const occ = computeOccupancy();
    const conflictCodes = new Set();
    Object.values(occ).forEach(arr => {
      if (arr.length > 1) arr.forEach(c => conflictCodes.add(c));
    });
    return conflictCodes;
  }

  /* ============== RENDER GRID ============== */
  const gridTable = document.getElementById("gridTable");

  function baseGridHTML() {
    const occ = computeOccupancy();
    const selected = State.getSelected();
    let html = `<caption class="visually-hidden">Grade horária semanal — as linhas são os horários de aula e as colunas os dias da semana; cada célula mostra as disciplinas alocadas naquele horário.</caption>`;
    html += "<thead><tr><th scope=\"col\" style='width:70px;'>Aula</th>";
    DAYS.forEach(d => html += `<th scope="col">${esc(d.label)}</th>`);
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
  function renderGrid() {
    gridTable.innerHTML = baseGridHTML();
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
  }

  /* ============== STATS + BANNER ============== */
  function renderStats() {
    const statsBar = document.getElementById("statsBar");
    const conflictBanner = document.getElementById("conflictBanner");
    const selected = State.getSelected();
    const count = State.countSelected();
    let totalAulas = 0;
    Object.values(selected).forEach(s => totalAulas += s.slots.length);
    const conflicts = computeConflictCodes();

    statsBar.innerHTML = `
      <div><b>${count}</b> disciplina(s) selecionada(s)</div>
      <div>⏱️ <b>${totalAulas}</b> aulas semanais alocadas</div>
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

  function renderAll() {
    renderSubjectList();
    renderGrid();
    renderStats();
    renderLegend();
    updateUndoButton();
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

  /* ============== COPY / PASTE ============== */
  document.getElementById("btnCopy").onclick = async () => {
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
  };

  document.getElementById("btnPaste").onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const pairRe = /([A-Za-z]{2,}\d[A-Za-z0-9]*)\s*,\s*([A-Za-z]*\d+[A-Za-z0-9]*)/g;
      const newSelected = {};
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
        newSelected[sub.code] = {
          code: sub.code, name: sub.name, turma: t.turma, prof: t.prof, h: t.h, slots, color: subjectColor(sub.code),
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
  };

  document.getElementById("btnClear").onclick = () => {
    if (State.countSelected() === 0) return;
    if (confirm("Tem certeza que deseja limpar todas as disciplinas selecionadas?")) {
      State.clearSelection();
      renderAll();
      toast("Seleção limpa.");
    }
  };

  document.getElementById("btnUndo").onclick = () => {
    if (State.undo()) { renderAll(); toast("Última ação desfeita."); }
  };
  document.getElementById("btnRedo").onclick = () => {
    if (State.redo()) { renderAll(); toast("Ação refeita."); }
  };

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return; // não interceptar digitação normal
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      if (e.shiftKey) { if (State.redo()) { renderAll(); toast("Ação refeita."); } }
      else { if (State.undo()) { renderAll(); toast("Última ação desfeita."); } }
    } else if ((e.ctrlKey || e.metaKey) && key === "y") {
      e.preventDefault();
      if (State.redo()) { renderAll(); toast("Ação refeita."); }
    }
  });

  searchBox.oninput = renderSubjectList;

  document.getElementById("filterAll").onclick = (e) => { setFilter("all", e.target); };
  document.getElementById("filterSelected").onclick = (e) => { setFilter("selected", e.target); };
  document.getElementById("filterConflict").onclick = (e) => { setFilter("conflict", e.target); };
  function setFilter(mode, btn) {
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

  function applyTheme(pref) {
    const isDark = pref === "dark" || (pref === "system" && mqDark.matches);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    document.querySelectorAll("#themeSwitch [data-theme-choice]").forEach(b => {
      const active = b.dataset.themeChoice === pref;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }
  function setThemePref(pref) {
    localStorage.setItem(THEME_KEY, pref);
    applyTheme(pref);
  }
  document.querySelectorAll("#themeSwitch [data-theme-choice]").forEach(btn => {
    btn.addEventListener("click", () => setThemePref(btn.dataset.themeChoice));
  });
  mqDark.addEventListener("change", () => {
    if ((localStorage.getItem(THEME_KEY) || "system") === "system") applyTheme("system");
  });
  applyTheme(localStorage.getItem(THEME_KEY) || "system");

  /* ============== INIT ============== */
  State.load();
  State.pruneAndRefresh((code, sel) => {
    const sub = DATA.find(s => s.code === code);
    if (!sub) return null;
    const t = sub.turmas.find(x => x.turma === sel.turma);
    if (!t) return null;
    return { slots: parseHorario(t.h), color: subjectColor(code) };
  });
  renderAll();
})();
