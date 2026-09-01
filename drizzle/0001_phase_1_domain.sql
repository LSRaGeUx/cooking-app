CREATE TABLE "allergen" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"severity" text NOT NULL,
	"matches" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allergen_user_name_key" UNIQUE("user_id","name"),
	CONSTRAINT "allergen_severity_known" CHECK ("allergen"."severity" in ('avoid', 'strict'))
);
--> statement-breakpoint
ALTER TABLE "allergen" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_user_key_key" UNIQUE("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "equipment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exclusion" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"matches" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exclusion_user_name_key" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "exclusion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"diet" text DEFAULT 'none' NOT NULL,
	"diet_notes" text,
	"skill_level" smallint DEFAULT 3 NOT NULL,
	"default_servings" smallint DEFAULT 2 NOT NULL,
	"default_time_budget_min" smallint,
	"variety_preference" smallint DEFAULT 3 NOT NULL,
	"weekly_budget_amount" numeric(10, 2),
	"weekly_budget_currency" char(3),
	"agent_authority" text DEFAULT 'proposal' NOT NULL,
	"time_budget_tolerance_min" smallint DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_diet_known" CHECK ("profile"."diet" in ('none', 'vegetarian', 'vegan', 'pescatarian', 'halal', 'kosher')),
	CONSTRAINT "profile_skill_range" CHECK ("profile"."skill_level" between 1 and 5),
	CONSTRAINT "profile_variety_range" CHECK ("profile"."variety_preference" between 1 and 5),
	CONSTRAINT "profile_servings_positive" CHECK ("profile"."default_servings" > 0),
	CONSTRAINT "profile_authority_known" CHECK ("profile"."agent_authority" in ('proposal', 'direct'))
);
--> statement-breakpoint
ALTER TABLE "profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "meal_type" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_type_user_key_key" UNIQUE("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "meal_type" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "slot_config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"day_of_week" smallint NOT NULL,
	"meal_type_id" uuid NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"time_budget_min" smallint,
	"default_servings" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_config_user_day_meal_key" UNIQUE("user_id","day_of_week","meal_type_id"),
	CONSTRAINT "slot_config_day_range" CHECK ("slot_config"."day_of_week" between 1 and 7),
	CONSTRAINT "slot_config_state_known" CHECK ("slot_config"."state" in ('planned', 'skipped', 'hidden'))
);
--> statement-breakpoint
ALTER TABLE "slot_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ingredient" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"canonical_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"aisle" text,
	"default_unit" text,
	"density_g_per_ml" numeric(10, 4),
	"allergen_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingredient_user_name_key" UNIQUE("user_id","canonical_name"),
	CONSTRAINT "ingredient_category_known" CHECK ("ingredient"."category" in ('produce', 'dairy', 'meat', 'fish', 'dry_goods', 'spice', 'frozen', 'other'))
);
--> statement-breakpoint
ALTER TABLE "ingredient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recipe" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"image_url" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_url" text,
	"source_client_id" text,
	"servings" smallint DEFAULT 2 NOT NULL,
	"prep_time_min" smallint,
	"cook_time_min" smallint,
	"active_time_min" smallint,
	"batch_friendly" boolean DEFAULT false NOT NULL,
	"keeps_days" smallint,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"cuisine" text,
	"main_protein" text,
	"difficulty" text,
	"equipment_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"allergen_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('french', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED,
	CONSTRAINT "recipe_source_known" CHECK ("recipe"."source" in ('manual', 'agent', 'import')),
	CONSTRAINT "recipe_servings_positive" CHECK ("recipe"."servings" > 0)
);
--> statement-breakpoint
ALTER TABLE "recipe" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recipe_ingredient" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"recipe_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"quantity" numeric(12, 3),
	"unit" text,
	"raw_name" text NOT NULL,
	"ingredient_id" uuid,
	"note" text,
	"optional" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recipe_revision" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"recipe_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_revision_recipe_revision_key" UNIQUE("recipe_id","revision")
);
--> statement-breakpoint
ALTER TABLE "recipe_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recipe_step" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"recipe_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"text" text NOT NULL,
	"duration_min" smallint,
	"unattended" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipe_step" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plan" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"iso_year" smallint NOT NULL,
	"iso_week" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_user_week_key" UNIQUE("user_id","iso_year","iso_week"),
	CONSTRAINT "plan_week_range" CHECK ("plan"."iso_week" between 1 and 53)
);
--> statement-breakpoint
ALTER TABLE "plan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plan_entry" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"meal_type_id" uuid NOT NULL,
	"recipe_id" uuid,
	"recipe_title_snapshot" text NOT NULL,
	"recipe_revision_snapshot" integer,
	"servings" smallint NOT NULL,
	"note" text,
	"rationale" text,
	"rationale_refs" jsonb,
	"position" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "plan_entry_day_range" CHECK ("plan_entry"."day_of_week" between 1 and 7),
	CONSTRAINT "plan_entry_servings_positive" CHECK ("plan_entry"."servings" > 0)
);
--> statement-breakpoint
ALTER TABLE "plan_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plan_version" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_by" text DEFAULT 'user' NOT NULL,
	"created_by_client_id" text,
	"summary" text,
	"slot_snapshot" jsonb NOT NULL,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "plan_version_plan_number_key" UNIQUE("plan_id","version_number"),
	CONSTRAINT "plan_version_state_known" CHECK ("plan_version"."state" in ('pending', 'active', 'superseded', 'rejected')),
	CONSTRAINT "plan_version_author_known" CHECK ("plan_version"."created_by" in ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "plan_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_activity" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
-- Hand-added: Postgres refuses to alter the type of a column named in a policy
-- expression, and the phase 0 policy casts user_id to uuid. Drop it first; the
-- generated ALTER POLICY at the end of this file was likewise changed to a
-- CREATE. See the note on user_id typing in docs/02-data-model.md section 2.
DROP POLICY "agent_activity_owner" ON "agent_activity";--> statement-breakpoint
ALTER TABLE "agent_activity" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "slot_config" ADD CONSTRAINT "slot_config_meal_type_id_meal_type_id_fk" FOREIGN KEY ("meal_type_id") REFERENCES "public"."meal_type"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_revision" ADD CONSTRAINT "recipe_revision_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_step" ADD CONSTRAINT "recipe_step_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entry" ADD CONSTRAINT "plan_entry_plan_version_id_plan_version_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entry" ADD CONSTRAINT "plan_entry_meal_type_id_meal_type_id_fk" FOREIGN KEY ("meal_type_id") REFERENCES "public"."meal_type"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entry" ADD CONSTRAINT "plan_entry_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingredient_user_idx" ON "ingredient" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recipe_user_idx" ON "recipe" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recipe_search_idx" ON "recipe" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "recipe_tags_idx" ON "recipe" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "recipe_ingredient_recipe_idx" ON "recipe_ingredient" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX "recipe_step_recipe_idx" ON "recipe_step" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX "plan_entry_version_idx" ON "plan_entry" USING btree ("plan_version_id","day_of_week");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_version_one_active_idx" ON "plan_version" USING btree ("plan_id") WHERE state = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "plan_version_one_pending_idx" ON "plan_version" USING btree ("plan_id") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "plan_version_plan_idx" ON "plan_version" USING btree ("plan_id","version_number" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "allergen_owner" ON "allergen" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("allergen"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("allergen"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "equipment_owner" ON "equipment" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("equipment"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("equipment"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "exclusion_owner" ON "exclusion" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("exclusion"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("exclusion"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "profile_owner" ON "profile" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("profile"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("profile"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "meal_type_owner" ON "meal_type" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("meal_type"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("meal_type"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "slot_config_owner" ON "slot_config" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("slot_config"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("slot_config"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "ingredient_owner" ON "ingredient" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("ingredient"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("ingredient"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "recipe_owner" ON "recipe" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("recipe"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("recipe"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "recipe_ingredient_owner" ON "recipe_ingredient" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("recipe_ingredient"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("recipe_ingredient"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "recipe_revision_owner" ON "recipe_revision" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("recipe_revision"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("recipe_revision"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "recipe_step_owner" ON "recipe_step" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("recipe_step"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("recipe_step"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "plan_owner" ON "plan" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("plan"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("plan"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "plan_entry_owner" ON "plan_entry" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("plan_entry"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("plan_entry"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "plan_version_owner" ON "plan_version" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("plan_version"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("plan_version"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "agent_activity_owner" ON "agent_activity" AS PERMISSIVE FOR ALL TO "cooking_app" USING ("agent_activity"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("agent_activity"."user_id" = nullif(current_setting('app.user_id', true), ''));