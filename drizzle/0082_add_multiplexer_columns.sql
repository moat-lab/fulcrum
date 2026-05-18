ALTER TABLE `hosts` ADD `multiplexer` text NOT NULL DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE `terminals` ADD `multiplexer_kind` text;
