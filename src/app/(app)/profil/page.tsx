import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ConstraintLists } from "@/components/profile/constraint-lists";
import { ProfileForm } from "@/components/profile/profile-form";
import { requireUser } from "@/lib/session";
import {
  getProfile,
  listAllergens,
  listEquipment,
  listExclusions,
} from "@/services/profile-service";

export default async function ProfilePage() {
  const { ctx } = await requireUser();
  const t = await getTranslations("profile");

  const profile = await getProfile(ctx);
  const allergens = await listAllergens(ctx);
  const exclusions = await listExclusions(ctx);
  const equipment = await listEquipment(ctx);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="max-w-2xl text-sm opacity-70">{t("intro")}</p>
        </div>
        <Link
          href="/profil/apercu"
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
        >
          {t("viewSnapshot")}
        </Link>
      </header>

      <ProfileForm
        profile={{
          diet: profile.diet,
          dietNotes: profile.dietNotes,
          skillLevel: profile.skillLevel,
          defaultServings: profile.defaultServings,
          defaultTimeBudgetMin: profile.defaultTimeBudgetMin,
          timeBudgetToleranceMin: profile.timeBudgetToleranceMin,
          varietyPreference: profile.varietyPreference,
          weeklyBudgetAmount:
            profile.weeklyBudgetAmount === null
              ? null
              : Number(profile.weeklyBudgetAmount),
          weeklyBudgetCurrency: profile.weeklyBudgetCurrency,
          agentAuthority: profile.agentAuthority,
        }}
      />

      <ConstraintLists
        allergens={allergens.map((row) => ({
          id: row.id,
          name: row.name,
          severity: row.severity,
          matches: row.matches,
        }))}
        exclusions={exclusions.map((row) => ({ id: row.id, name: row.name }))}
        equipment={equipment.map((row) => ({
          id: row.id,
          key: row.key,
          label: row.label,
        }))}
      />
    </div>
  );
}
