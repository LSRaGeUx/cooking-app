import type { IngredientCategory } from "@/domain/vocabulary";

/**
 * The seeded starter set. Its only job is to make grocery merging and allergen
 * derivation work on day one, before the user has curated anything: an
 * ingredient typed as "spaghetti" links to `Pâtes` and inherits its aisle and
 * its allergens.
 *
 * Deliberately short. A long list is a curation chore, and the parser links
 * best-effort anyway, so an unknown ingredient costs nothing but a merge.
 *
 * An alias means "this text resolves to that ingredient", and nothing more. It
 * is read for linking, for the aisle and for the allergens, and never as a
 * claim that the two are the same thing to buy: most of these are not, from
 * "spaghetti" under `Pâtes` to "thym" under `Herbes de Provence`. The grocery
 * list therefore names a line after what the recipe wrote unless the written
 * name is the canonical one, so an alias here can be as loose as linking needs
 * without putting the wrong word on the list. See `productOf` in
 * src/domain/grocery.ts.
 */
export interface StarterIngredient {
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly category: IngredientCategory;
  readonly aisle: string;
  readonly defaultUnit?: string;
}

const PRODUCE = "Fruits et légumes";
const DAIRY = "Crémerie";
const BUTCHER = "Boucherie";
const FISH = "Poissonnerie";
const GROCERY = "Épicerie salée";
const SWEET = "Épicerie sucrée";
const FROZEN = "Surgelés";
const BAKERY = "Boulangerie";

export const STARTER_INGREDIENTS: readonly StarterIngredient[] = [
  { canonicalName: "Oignon", aliases: ["oignons", "oignon jaune", "oignon rouge"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Ail", aliases: ["gousse d'ail", "gousses d'ail"], category: "produce", aisle: PRODUCE, defaultUnit: "gousse" },
  { canonicalName: "Échalote", aliases: ["echalote", "échalotes"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Carotte", aliases: ["carottes"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Pomme de terre", aliases: ["pommes de terre", "patate", "patates"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Tomate", aliases: ["tomates", "tomates concassées", "tomate pelée"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Courgette", aliases: ["courgettes"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Aubergine", aliases: ["aubergines"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Poivron", aliases: ["poivrons", "poivron rouge", "poivron vert"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Champignon de Paris", aliases: ["champignons", "champignon"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Poireau", aliases: ["poireaux"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Épinard", aliases: ["epinard", "épinards", "pousses d'épinard"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Salade verte", aliases: ["laitue", "batavia", "sucrine"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Citron", aliases: ["citrons", "citron jaune"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Citron vert", aliases: ["citrons verts", "lime"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Persil", aliases: ["persil plat", "persil frisé"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Coriandre", aliases: ["coriandre fraîche"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Basilic", aliases: ["basilic frais"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Gingembre", aliases: ["gingembre frais"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Pomme", aliases: ["pommes"], category: "produce", aisle: PRODUCE },
  { canonicalName: "Banane", aliases: ["bananes"], category: "produce", aisle: PRODUCE },

  { canonicalName: "Lait", aliases: ["lait entier", "lait demi-écrémé"], category: "dairy", aisle: DAIRY, defaultUnit: "ml" },
  { canonicalName: "Beurre", aliases: ["beurre doux", "beurre demi-sel"], category: "dairy", aisle: DAIRY, defaultUnit: "g" },
  { canonicalName: "Crème fraîche", aliases: ["creme fraiche", "crème liquide", "fleurette"], category: "dairy", aisle: DAIRY, defaultUnit: "ml" },
  { canonicalName: "Yaourt nature", aliases: ["yaourt", "yaourts"], category: "dairy", aisle: DAIRY },
  { canonicalName: "Œuf", aliases: ["oeuf", "oeufs", "œufs"], category: "dairy", aisle: DAIRY },
  { canonicalName: "Gruyère râpé", aliases: ["gruyere rape", "fromage râpé", "emmental râpé"], category: "dairy", aisle: DAIRY, defaultUnit: "g" },
  { canonicalName: "Parmesan", aliases: ["parmigiano"], category: "dairy", aisle: DAIRY, defaultUnit: "g" },
  { canonicalName: "Mozzarella", aliases: ["mozzarela"], category: "dairy", aisle: DAIRY, defaultUnit: "g" },

  { canonicalName: "Blanc de poulet", aliases: ["poulet", "escalope de poulet", "filet de poulet"], category: "meat", aisle: BUTCHER, defaultUnit: "g" },
  { canonicalName: "Bœuf haché", aliases: ["boeuf hache", "viande hachée", "steak haché"], category: "meat", aisle: BUTCHER, defaultUnit: "g" },
  { canonicalName: "Lardons", aliases: ["lardon", "poitrine fumée"], category: "meat", aisle: BUTCHER, defaultUnit: "g" },
  { canonicalName: "Jambon blanc", aliases: ["jambon"], category: "meat", aisle: BUTCHER },
  { canonicalName: "Saumon", aliases: ["pavé de saumon", "filet de saumon"], category: "fish", aisle: FISH, defaultUnit: "g" },
  { canonicalName: "Thon en conserve", aliases: ["thon", "miettes de thon"], category: "fish", aisle: GROCERY },

  { canonicalName: "Pâtes", aliases: ["pates", "spaghetti", "penne", "tagliatelles"], category: "dry_goods", aisle: GROCERY, defaultUnit: "g" },
  { canonicalName: "Riz", aliases: ["riz basmati", "riz long"], category: "dry_goods", aisle: GROCERY, defaultUnit: "g" },
  { canonicalName: "Lentilles", aliases: ["lentilles vertes", "lentilles corail"], category: "dry_goods", aisle: GROCERY, defaultUnit: "g" },
  { canonicalName: "Pois chiches", aliases: ["pois chiche"], category: "dry_goods", aisle: GROCERY, defaultUnit: "g" },
  { canonicalName: "Farine", aliases: ["farine de blé", "farine T55", "farine T65"], category: "dry_goods", aisle: SWEET, defaultUnit: "g" },
  { canonicalName: "Semoule", aliases: ["couscous", "semoule de blé"], category: "dry_goods", aisle: GROCERY, defaultUnit: "g" },
  { canonicalName: "Huile d'olive", aliases: ["huile olive"], category: "dry_goods", aisle: GROCERY, defaultUnit: "ml" },
  { canonicalName: "Huile de tournesol", aliases: ["huile neutre", "huile"], category: "dry_goods", aisle: GROCERY, defaultUnit: "ml" },
  { canonicalName: "Vinaigre balsamique", aliases: ["balsamique"], category: "dry_goods", aisle: GROCERY, defaultUnit: "ml" },
  { canonicalName: "Moutarde", aliases: ["moutarde de Dijon"], category: "dry_goods", aisle: GROCERY },
  { canonicalName: "Bouillon de légumes", aliases: ["cube de bouillon", "bouillon"], category: "dry_goods", aisle: GROCERY },
  { canonicalName: "Lait de coco", aliases: ["creme de coco", "crème de coco"], category: "dry_goods", aisle: GROCERY, defaultUnit: "ml" },
  { canonicalName: "Sauce soja", aliases: ["soja", "sauce soya"], category: "dry_goods", aisle: GROCERY, defaultUnit: "ml" },

  { canonicalName: "Sel", aliases: ["sel fin", "gros sel", "fleur de sel"], category: "spice", aisle: GROCERY },
  { canonicalName: "Poivre", aliases: ["poivre noir", "poivre du moulin"], category: "spice", aisle: GROCERY },
  { canonicalName: "Paprika", aliases: ["paprika fumé"], category: "spice", aisle: GROCERY },
  { canonicalName: "Cumin", aliases: ["cumin moulu"], category: "spice", aisle: GROCERY },
  { canonicalName: "Curry", aliases: ["curry en poudre"], category: "spice", aisle: GROCERY },
  { canonicalName: "Herbes de Provence", aliases: ["thym", "romarin"], category: "spice", aisle: GROCERY },
  { canonicalName: "Sucre", aliases: ["sucre en poudre", "sucre blanc"], category: "spice", aisle: SWEET, defaultUnit: "g" },

  { canonicalName: "Petits pois surgelés", aliases: ["petits pois"], category: "frozen", aisle: FROZEN, defaultUnit: "g" },
  { canonicalName: "Épinards surgelés", aliases: ["epinards surgeles"], category: "frozen", aisle: FROZEN, defaultUnit: "g" },

  { canonicalName: "Pain", aliases: ["baguette", "pain de campagne"], category: "other", aisle: BAKERY },
  { canonicalName: "Pâte brisée", aliases: ["pate brisee", "pâte feuilletée"], category: "other", aisle: DAIRY },
];
