/** Data classification used in routing and tool authorization. */
export type DataClassification = "public" | "private" | "sensitive" | "local-only";

export type DataDestination = "local" | "selfhosted" | "external";

const ORDER: Record<DataClassification, number> = {
  "local-only": 3,
  sensitive: 2,
  private: 1,
  public: 0,
};

export function classificationRank(c: DataClassification): number {
  return ORDER[c];
}

export function maxClassification(a: DataClassification, b: DataClassification): DataClassification {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/**
 * Default policy: external hosted providers may receive at most `private`
 * classified content; `sensitive` and `local-only` never leave the machine
 * unless the user explicitly lowers this per destination.
 */
export function defaultMaxClassificationFor(destination: DataDestination): DataClassification | "none" {
  switch (destination) {
    case "local":
      return "local-only";
    case "selfhosted":
      return "sensitive";
    case "external":
      return "private";
  }
}
