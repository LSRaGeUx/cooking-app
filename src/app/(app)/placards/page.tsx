import { getTranslations } from "next-intl/server";
import { PantryLists } from "@/components/pantry/pantry-lists";
import { requireUser } from "@/lib/session";
import { listPantry } from "@/services/pantry-service";

export default async function PantryPage() {
  const { ctx } = await requireUser();
  const t = await getTranslations("pantry");
  const items = await listPantry(ctx);

  return (
    <div className="page mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2 border-b border-rule pb-4">
        <h1 className="title rise">{t("title")}</h1>
        <p className="lede">{t("intro")}</p>
      </header>

      <PantryLists items={items} />
    </div>
  );
}
