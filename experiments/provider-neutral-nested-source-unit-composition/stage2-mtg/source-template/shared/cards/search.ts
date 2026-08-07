import type { CardEntry } from "./database.ts";

export interface SearchInput {
  text?: string;
  type?: string;
  color?: string;
  maximumCmc?: number;
}

export function searchCards(
  cards: ReadonlyMap<string, Readonly<CardEntry>>,
  input: Readonly<SearchInput>
): Readonly<CardEntry>[] {
  const text = input.text?.toLocaleLowerCase("en-US");
  const type = input.type?.toLocaleLowerCase("en-US");
  const allowedColors = new Set((input.color ?? "").toUpperCase().split(""));
  return [...cards.values()]
    .filter((card) => text === undefined
      || card.name.toLocaleLowerCase("en-US").includes(text)
      || card.oracleText.toLocaleLowerCase("en-US").includes(text))
    .filter((card) => type === undefined || card.typeLine.toLocaleLowerCase("en-US").includes(type))
    .filter((card) => input.maximumCmc === undefined || card.cmc <= input.maximumCmc)
    .filter((card) => allowedColors.size === 0
      || card.colorIdentity.every((color) => allowedColors.has(color)))
    .sort((left, right) => left.cmc - right.cmc || left.name.localeCompare(right.name, "en-US"));
}
