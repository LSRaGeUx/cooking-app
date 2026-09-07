-- Hand-edited after generation, in two places. Both were wrong as generated:
--
-- 1. drizzle-kit emitted the composite foreign keys BEFORE the
--    UNIQUE("id","user_id") constraints they reference, and Postgres refuses a
--    foreign key whose target has no matching unique constraint yet ("there is
--    no unique constraint matching given keys for referenced table"). The
--    unique constraints are moved ahead of the foreign keys.
--
-- 2. `ALTER COLUMN ... SET NOT NULL` on fact.evidence and
--    plan_entry.rationale_refs had no backfill. `SET DEFAULT` applies to future
--    inserts only, so any existing row holding NULL would have failed the
--    constraint and taken the whole migration with it. The two UPDATE
--    statements below are the backfill, and they run before the constraint.
--
-- Nothing here drops and recreates a column, so no data moves.

--> Old single-column foreign keys, replaced by composite ones below.
ALTER TABLE "entry_feedback" DROP CONSTRAINT "entry_feedback_plan_entry_id_plan_entry_id_fk";
--> statement-breakpoint
ALTER TABLE "grocery_line" DROP CONSTRAINT "grocery_line_grocery_list_id_grocery_list_id_fk";
--> statement-breakpoint
ALTER TABLE "grocery_list_version" DROP CONSTRAINT "grocery_list_version_grocery_list_id_grocery_list_id_fk";
--> statement-breakpoint
ALTER TABLE "grocery_list_version" DROP CONSTRAINT "grocery_list_version_plan_version_id_plan_version_id_fk";
--> statement-breakpoint
ALTER TABLE "slot_config" DROP CONSTRAINT "slot_config_meal_type_id_meal_type_id_fk";
--> statement-breakpoint
ALTER TABLE "recipe_ingredient" DROP CONSTRAINT "recipe_ingredient_recipe_id_recipe_id_fk";
--> statement-breakpoint
ALTER TABLE "recipe_revision" DROP CONSTRAINT "recipe_revision_recipe_id_recipe_id_fk";
--> statement-breakpoint
ALTER TABLE "recipe_step" DROP CONSTRAINT "recipe_step_recipe_id_recipe_id_fk";
--> statement-breakpoint
ALTER TABLE "plan_entry" DROP CONSTRAINT "plan_entry_plan_version_id_plan_version_id_fk";
--> statement-breakpoint
ALTER TABLE "plan_entry" DROP CONSTRAINT "plan_entry_meal_type_id_meal_type_id_fk";
--> statement-breakpoint
ALTER TABLE "plan_version" DROP CONSTRAINT "plan_version_plan_id_plan_id_fk";
--> statement-breakpoint
ALTER TABLE "prep_link" DROP CONSTRAINT "prep_link_dependent_entry_id_plan_entry_id_fk";
--> statement-breakpoint
DROP INDEX "grocery_list_version_list_idx";--> statement-breakpoint
DROP INDEX "recipe_user_idx";--> statement-breakpoint
DROP INDEX "pantry_item_user_kind_idx";--> statement-breakpoint
--> Reference targets for the composite foreign keys. Moved ahead of them.
ALTER TABLE "grocery_list" ADD CONSTRAINT "grocery_list_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "meal_type" ADD CONSTRAINT "meal_type_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "plan_entry" ADD CONSTRAINT "plan_entry_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
--> The composite keys themselves: a child row's denormalized user_id can no
--> longer disagree with its parent's.
ALTER TABLE "entry_feedback" ADD CONSTRAINT "entry_feedback_plan_entry_user_fk" FOREIGN KEY ("plan_entry_id","user_id") REFERENCES "public"."plan_entry"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_line" ADD CONSTRAINT "grocery_line_list_user_fk" FOREIGN KEY ("grocery_list_id","user_id") REFERENCES "public"."grocery_list"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_list_version" ADD CONSTRAINT "grocery_list_version_list_user_fk" FOREIGN KEY ("grocery_list_id","user_id") REFERENCES "public"."grocery_list"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_list_version" ADD CONSTRAINT "grocery_list_version_plan_version_user_fk" FOREIGN KEY ("plan_version_id","user_id") REFERENCES "public"."plan_version"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_config" ADD CONSTRAINT "slot_config_meal_type_user_fk" FOREIGN KEY ("meal_type_id","user_id") REFERENCES "public"."meal_type"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_recipe_user_fk" FOREIGN KEY ("recipe_id","user_id") REFERENCES "public"."recipe"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_revision" ADD CONSTRAINT "recipe_revision_recipe_user_fk" FOREIGN KEY ("recipe_id","user_id") REFERENCES "public"."recipe"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_step" ADD CONSTRAINT "recipe_step_recipe_user_fk" FOREIGN KEY ("recipe_id","user_id") REFERENCES "public"."recipe"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entry" ADD CONSTRAINT "plan_entry_plan_version_user_fk" FOREIGN KEY ("plan_version_id","user_id") REFERENCES "public"."plan_version"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entry" ADD CONSTRAINT "plan_entry_meal_type_user_fk" FOREIGN KEY ("meal_type_id","user_id") REFERENCES "public"."meal_type"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_plan_user_fk" FOREIGN KEY ("plan_id","user_id") REFERENCES "public"."plan"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_link" ADD CONSTRAINT "prep_link_dependent_entry_user_fk" FOREIGN KEY ("dependent_entry_id","user_id") REFERENCES "public"."plan_entry"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
--> Backfill, then the not-null constraint. A reader now gets [] and never null.
UPDATE "fact" SET "evidence" = '[]'::jsonb WHERE "evidence" IS NULL;--> statement-breakpoint
ALTER TABLE "fact" ALTER COLUMN "evidence" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "fact" ALTER COLUMN "evidence" SET NOT NULL;--> statement-breakpoint
UPDATE "plan_entry" SET "rationale_refs" = '[]'::jsonb WHERE "rationale_refs" IS NULL;--> statement-breakpoint
ALTER TABLE "plan_entry" ALTER COLUMN "rationale_refs" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "plan_entry" ALTER COLUMN "rationale_refs" SET NOT NULL;--> statement-breakpoint
--> Soft delete for the pantry, so an agent's removal is reversible (rule 6).
ALTER TABLE "pantry_item" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
--> Foreign key columns Postgres does not index for you.
CREATE INDEX "fact_supersedes_idx" ON "fact" USING btree ("supersedes_id");--> statement-breakpoint
CREATE INDEX "grocery_line_ingredient_idx" ON "grocery_line" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "grocery_list_version_plan_version_idx" ON "grocery_list_version" USING btree ("plan_version_id");--> statement-breakpoint
CREATE INDEX "slot_config_meal_type_idx" ON "slot_config" USING btree ("meal_type_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredient_ingredient_idx" ON "recipe_ingredient" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "plan_entry_recipe_idx" ON "plan_entry" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "plan_entry_meal_type_idx" ON "plan_entry" USING btree ("meal_type_id");--> statement-breakpoint
CREATE INDEX "pantry_item_ingredient_idx" ON "pantry_item" USING btree ("ingredient_id");--> statement-breakpoint
--> Partial, because every listing filters on the same predicate.
CREATE INDEX "recipe_user_idx" ON "recipe" USING btree ("user_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "pantry_item_user_kind_idx" ON "pantry_item" USING btree ("user_id","kind") WHERE removed_at is null;--> statement-breakpoint
--> The audit log's two enum-like columns, constrained like every other one.
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_direction_known" CHECK ("agent_activity"."direction" in ('read', 'write'));--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_result_known" CHECK ("agent_activity"."result" in ('ok', 'rejected', 'error'));
