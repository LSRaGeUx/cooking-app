import { getTranslations } from "next-intl/server";
import { SlotEditor } from "@/components/slots/slot-editor";
import { requireUser } from "@/lib/session";
import { listMealTypes, loadSlotDefinitions } from "@/services/slot-service";

export default async function SlotsPage() {
  const { ctx } = await requireUser();
  const t = await getTranslations("slots");

  const mealTypes = await listMealTypes(ctx);
  const slots = await loadSlotDefinitions(ctx);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="max-w-2xl text-sm opacity-70">{t("intro")}</p>
      </header>

      <SlotEditor
        mealTypes={mealTypes.map((meal) => ({
          id: meal.id,
          key: meal.key,
          label: meal.label,
        }))}
        slots={slots}
      />
    </div>
  );
}
