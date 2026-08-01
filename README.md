# Monta Horario UTFPR


**Website:** https://bolsgo.github.io/monta-horario-utfpr/

Aplicação web desenvolvida para simplificar a organização semestral dos estudantes da UTFPR. A ferramenta permite buscar turmas, montar a grade semanal, receber alertas visuais sobre choques de horário e salvar o progresso localmente.

Feito para uso pessoal.

## Estrutura dos dados (por sede e por curso)

Os dados são organizados
em duas camadas.

- `data/sedes.json` lista as sedes disponíveis (por enquanto só Curitiba).
- `data/<sede>/manifest.json` lista os cursos daquela sede.
- `data/<sede>/<slug>.json` guarda as disciplinas de um curso específico.

A página carrega só o JSON do curso escolhido nos seletores (sede + curso) 
os demais nunca são baixados. `config.js` guarda o que é igual pra todo
curso e toda sede (dias da semana, horários das aulas, paleta de cores).

### Adicionar um novo curso (sede já existente, funcionando 2026/2)

1. Abra `gerador.html` no navegador.
2. Cole o HTML do relatório "Turmas Abertas" da UTFPR desse curso (firefox: This Frame > View Frame Source).
3. Preencha a sede (ex: `curitiba`), o slug do curso (ex: `eng-eletrica`) e
   o nome exibido (ex: `Engenharia Mecânica`).
4. Clique em "Gerar JSON do curso" e depois em "Baixar arquivo".
5. Salve o arquivo baixado como `data/<sede>/<slug>.json` no repositório.
6. Adicione `{ "slug": "<slug>", "label": "<nome>" }` em
   `data/<sede>/manifest.json`.

### Adicionar uma nova sede

1. Crie a pasta `data/<sede>/` com seu próprio `manifest.json` (pode
   começar com `[]` e ir preenchendo com o passo acima).
2. Adicione `{ "slug": "<sede>", "label": "<nome da sede>" }` em
   `data/sedes.json`.

> **Nota:** como os dados são buscados via `fetch`, abrir `index.html`
> direto do disco (`file://`) não funciona em todos os navegadores, sirva
> a pasta com um servidor local (ex: `npx serve` ou a extensão "Live Server").
