import { loadCards } from "../../shared/cards/database.ts";
import { searchCards } from "../../shared/cards/search.ts";
import { canonicalJson, loadApprovedReferences } from "../../shared/references.ts";

const cards = await loadCards(new URL("../../shared/fixtures/cards.json", import.meta.url));
const matches = searchCards(cards, { text: "draw", type: "sorcery", color: "G", maximumCmc: 4 });
const references = await loadApprovedReferences();

process.stdout.write(`${canonicalJson({
  child: "card-search",
  input: "shared/fixtures/cards.json",
  query: { color: "G", maximumCmc: 4, text: "draw", type: "sorcery" },
  references,
  results: matches.map(({ cmc, manaCost, name, oracleText, typeLine }) => ({
    cmc,
    manaCost,
    name,
    oracleText,
    typeLine
  }))
})}\n`);
