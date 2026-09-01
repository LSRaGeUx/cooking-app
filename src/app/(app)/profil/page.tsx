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
    <div className="page flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
        <div className="flex flex-col gap-2">
          <h1 className="title rise">{t("title")}</h1>
          <p className="lede">{t("intro")}</p>
        </div>
        <Link href="/profil/apercu" className="btn btn-quiet">
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
          shoppingDay: profile.shoppingDay,
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
