/* ============================================================
   config.js — Configuração da grade (dias, aulas, paleta de cores)
   Compartilhada por TODOS os cursos — não muda de curso pra curso,
   por isso fica separada dos data/*.json (que são só as disciplinas).
   ============================================================ */

const DAYS = [{"n":2,"label":"Segunda"},{"n":3,"label":"Terça"},{"n":4,"label":"Quarta"},{"n":5,"label":"Quinta"},{"n":6,"label":"Sexta"},{"n":7,"label":"Sábado"}];

const AULAS = [{"code":"M1","turno":"M","start":"07:30","end":"08:20"},{"code":"M2","turno":"M","start":"08:20","end":"09:10"},{"code":"M3","turno":"M","start":"09:10","end":"10:00"},{"code":"M4","turno":"M","start":"10:20","end":"11:10"},{"code":"M5","turno":"M","start":"11:10","end":"12:00"},{"code":"M6","turno":"M","start":"12:00","end":"12:50"},{"code":"T1","turno":"T","start":"13:00","end":"13:50"},{"code":"T2","turno":"T","start":"13:50","end":"14:40"},{"code":"T3","turno":"T","start":"14:40","end":"15:30"},{"code":"T4","turno":"T","start":"15:50","end":"16:40"},{"code":"T5","turno":"T","start":"16:40","end":"17:30"},{"code":"T6","turno":"T","start":"17:50","end":"18:40"},{"code":"N1","turno":"N","start":"18:40","end":"19:30"},{"code":"N2","turno":"N","start":"19:30","end":"20:20"},{"code":"N3","turno":"N","start":"20:20","end":"21:10"},{"code":"N4","turno":"N","start":"21:20","end":"22:10"},{"code":"N5","turno":"N","start":"22:10","end":"23:00"}];

/* Paleta de cores expandida e mais variada — sem tons de vermelho,
   para não se confundir com a cor de conflito de horário. */
const PALETTE = [
  "#2c6e49",
  "#00509d",
  "#7b2cbf",
  "#ca6702",
  "#4a4e69",
  "#006d77",
  "#606c38",
  "#023e8a",
  "#386641",
  "#5a189a",
  "#457b9d",
  "#7f4f24",
  "#2a9d8f",
  "#1d3557",
  "#6a994e",
  "#9d4edd",
  "#0081a7",
  "#5e548e",
  "#2d6a4f",
  "#936639",
  "#3c096c",
  "#0077b6"
];
