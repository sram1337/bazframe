import { loadCards, loadDeck } from "../../shared/cards/database.ts";
import { searchCards } from "../../shared/cards/search.ts";
import { canonicalJson, loadApprovedReferences } from "../../shared/references.ts";

const cards = await loadCards(new URL("../../shared/fixtures/cards.json", import.meta.url));
const deck = await loadDeck(new URL("../../shared/fixtures/deck.json", import.meta.url));
const references = await loadApprovedReferences();
const categoryCounts = new Map<string, number>();
const missingCards: string[] = [];
let totalCmc = 0;
let totalCards = 0;

for (const entry of deck.cards) {
  const card = cards.get(entry.name);
  if (card === undefined) {
    missingCards.push(entry.name);
    continue;
  }
  totalCards += entry.quantity;
  totalCmc += card.cmc * entry.quantity;
  for (const category of entry.categories) {
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + entry.quantity);
  }
}

process.stdout.write(`${canonicalJson({
  averageCmc: totalCards === 0 ? 0 : totalCmc / totalCards,
  child: "deck-analysis",
  deck: deck.name,
  drawCards: searchCards(cards, { text: "draw" }).map(({ name }) => name),
  input: "shared/fixtures/deck.json",
  missingCards: missingCards.sort((left, right) => left.localeCompare(right, "en-US")),
  references,
  roles: [...categoryCounts].sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([category, count]) => ({ category, count })),
  totalCards
})}\n`);
