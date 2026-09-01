import { redirect } from "next/navigation";
import { currentIsoWeek, formatIsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";

/**
 * The week screen is the product, so the root is a redirect to it rather than a
 * dashboard. Weeks are deep-linkable, hence the explicit ISO week in the path.
 */
export default async function Home() {
  await requireUser();
  redirect(`/semaine/${formatIsoWeek(currentIsoWeek())}`);
}
