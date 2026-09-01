CREATE TABLE "grocery_list_version" (
	"user_id" text NOT NULL,
	"grocery_list_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	CONSTRAINT "grocery_list_version_grocery_list_id_plan_version_id_pk" PRIMARY KEY("grocery_list_id","plan_version_id")
);
--> statement-breakpoint
ALTER TABLE "grocery_list_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grocery_list" ADD COLUMN "starts_on" date;--> statement-breakpoint
ALTER TABLE "grocery_list" ADD COLUMN "ends_on" date;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "shopping_day" smallint;--> statement-breakpoint
ALTER TABLE "grocery_list_version" ADD CONSTRAINT "grocery_list_version_grocery_list_id_grocery_list_id_fk" FOREIGN KEY ("grocery_list_id") REFERENCES "public"."grocery_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_list_version" ADD CONSTRAINT "grocery_list_version_plan_version_id_plan_version_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grocery_list_version_list_idx" ON "grocery_list_version" USING btree ("grocery_list_id");--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_shopping_day_range" CHECK ("profile"."shopping_day" is null or "profile"."shopping_day" between 1 and 7);--> statement-breakpoint
CREATE POLICY "grocery_list_version_owner" ON "grocery_list_version" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("grocery_list_version"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("grocery_list_version"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
-- Backfill. Every list that exists today covers the Monday-to-Sunday week of
-- the version it was generated from, so that is the cycle it is given.
-- to_date with IYYY-IW returns the Monday of an ISO week, which is exactly the
-- start of a Monday cycle.
UPDATE "grocery_list" AS gl
SET "starts_on" = to_date(p."iso_year" || '-' || lpad(p."iso_week"::text, 2, '0'), 'IYYY-IW'),
    "ends_on" = to_date(p."iso_year" || '-' || lpad(p."iso_week"::text, 2, '0'), 'IYYY-IW') + 6
FROM "plan_version" pv
JOIN "plan" p ON p."id" = pv."plan_id"
WHERE pv."id" = gl."plan_version_id";--> statement-breakpoint
-- The single version each list was built from becomes its first contributing
-- version, so staleness keeps working across the change.
INSERT INTO "grocery_list_version" ("user_id", "grocery_list_id", "plan_version_id")
SELECT gl."user_id", gl."id", gl."plan_version_id"
FROM "grocery_list" gl
ON CONFLICT DO NOTHING;
