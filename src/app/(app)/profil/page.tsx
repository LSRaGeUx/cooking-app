import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ConstraintLists } from "@/components/profile/constraint-lists";
import { ProfileForm } from "@/components/profile/profile-form";
import {
  AGENT_AUTHORITIES,
  ALLERGEN_SEVERITIES,
  DIETS,
} from "@/domain/vocabulary";
import { loadProfile } from "@/lib/page-data";
import { requireUser } from "@/lib/session";
import {
  listAllergens,
  listEquipment,
  listExclusions,
} from "@/services/profile-service";

export default async function ProfilePage() {
  const { ctx } = await requireUser();
  const t = await getTranslations("profile");

  // Four independent reads, in parallel. They were awaited in sequence, so the
  // page cost four round trips instead of one. `loadProfile` is the memoized
  // read, so the layout's own call and this one are a single query.
  const [profile, allergens, exclusions, equipment] = await Promise.all([
    loadProfile(ctx),
    listAllergens(ctx),
    listExclusions(ctx),
    listEquipment(ctx),
  ]);

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
          /*
           * Narrowed here rather than asserted. The profile row types these
           * two columns as `string`, the form types them as the vocabulary
           * unions they actually are, and a value the enum does not have falls
           * back to the vocabulary's own default so the select still shows
           * something it offers. Tightening the row type is a service change
           * and would make both of these redundant.
           */
          diet: oneOf(DIETS, profile.diet, "none"),
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
          agentAuthority: oneOf(
            AGENT_AUTHORITIES,
            profile.agentAuthority,
            "proposal",
          ),
        }}
      />

      <ConstraintLists
        allergens={allergens.map((row) => ({
          id: row.id,
          name: row.name,
          severity: oneOf(ALLERGEN_SEVERITIES, row.severity, "strict"),
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

/**
 * A stored string as one of a vocabulary's values, or the fallback.
 *
 * Not an assertion: the columns carry a check constraint, so a value outside
 * the list should be impossible, but a row written before the vocabulary
 * changed is exactly the case where "should be impossible" renders a select
 * with no selection at all.
 */
function oneOf<T extends string>(
  vocabulary: readonly T[],
  value: string,
  fallback: T,
): T {
  return (vocabulary as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
