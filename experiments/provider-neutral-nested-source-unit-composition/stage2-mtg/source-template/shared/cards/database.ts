import { readFile } from "node:fs/promises";

export interface CardEntry {
  name: string;
  oracleText: string;
  typeLine: string;
  manaCost: string;
  cmc: number;
  keywords: string[];
  colorIdentity: string[];
  power?: string;
  toughness?: string;
}

export interface DeckCard {
  name: string;
  quantity: number;
  categories: string[];
}

export interface DeckFixture {
  name: string;
  cards: DeckCard[];
}

export async function loadCards(input: URL): Promise<ReadonlyMap<string, Readonly<CardEntry>>> {
  const cards = JSON.parse(await readFile(input, "utf8")) as CardEntry[];
  return new Map(cards.map((card) => [card.name, Object.freeze({ ...card })]));
}

export async function loadDeck(input: URL): Promise<Readonly<DeckFixture>> {
  const deck = JSON.parse(await readFile(input, "utf8")) as DeckFixture;
  return Object.freeze({ ...deck, cards: deck.cards.map((card) => Object.freeze({ ...card })) });
}
