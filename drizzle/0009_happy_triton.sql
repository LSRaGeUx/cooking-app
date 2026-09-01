ALTER TABLE "grocery_list" DROP CONSTRAINT "grocery_list_plan_version_id_plan_version_id_fk";
--> statement-breakpoint
DROP INDEX "grocery_list_one_live_per_version_idx";--> statement-breakpoint
ALTER TABLE "grocery_list" ALTER COLUMN "starts_on" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "grocery_list" ALTER COLUMN "ends_on" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "grocery_list_one_live_per_cycle_idx" ON "grocery_list" USING btree ("user_id","starts_on") WHERE state <> 'archived';--> statement-breakpoint
ALTER TABLE "grocery_list" DROP COLUMN "plan_version_id";