-- ==========================================================
-- NOVA Database Schema Dump for FreeSQLDatabase (phpMyAdmin)
-- Database Target: sql12836921 @ sql12.freesqldatabase.com
-- Compatible with MySQL 5.5 / 5.6 / 5.7 / 8.0 & MariaDB
-- ==========================================================

SET FOREIGN_KEY_CHECKS = 0;
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET time_zone = "+00:00";

-- --------------------------------------------------------
-- Table structure for table: users
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `fullName` VARCHAR(255) NOT NULL,
    `organization` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL UNIQUE,
    `passwordHash` VARCHAR(255) NULL,
    `googleId` VARCHAR(255) NULL UNIQUE,
    `authProvider` ENUM('local', 'google') NOT NULL DEFAULT 'local',
    `passwordResetTokenHash` VARCHAR(255) NULL,
    `passwordResetExpires` DATETIME NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table structure for table: campaigns
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `campaigns` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `title` VARCHAR(255) NOT NULL,
    `workMail` VARCHAR(255) NULL,
    `followups` VARCHAR(32) NOT NULL DEFAULT '0',
    `camp_status` VARCHAR(64) NOT NULL DEFAULT 'Pending',
    `scheduledDate` DATETIME NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'draft',
    `subject` VARCHAR(255) NULL,
    `body` MEDIUMTEXT NULL,
    `total_recipients` INT NOT NULL DEFAULT 0,
    `sent_count` INT NOT NULL DEFAULT 0,
    `failed_count` INT NOT NULL DEFAULT 0,
    `user_id` INT NOT NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_campaigns_user` (`user_id`),
    CONSTRAINT `fk_campaigns_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table structure for table: mails
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `mails` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `campaign_id` INT NOT NULL,
    `user_id` INT NOT NULL,
    `email` VARCHAR(255) NULL,
    `full_name` VARCHAR(255) NULL,
    `status` TINYINT(1) NOT NULL DEFAULT 0,
    `delivery_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `open_count` INT NOT NULL DEFAULT 0,
    `click_count` INT NOT NULL DEFAULT 0,
    `first_opened_at` DATETIME NULL,
    `last_opened_at` DATETIME NULL,
    `sent_at` DATETIME NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_mails_campaign` (`campaign_id`),
    INDEX `idx_mails_user` (`user_id`),
    CONSTRAINT `fk_mails_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_mails_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table structure for table: conversations
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `conversations` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT NOT NULL,
    `title` VARCHAR(255) NOT NULL DEFAULT 'New conversation',
    `thread_id` VARCHAR(255) NULL,
    `expiresAt` DATETIME NOT NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_conversations_user` (`user_id`),
    CONSTRAINT `fk_conversations_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table structure for table: messages
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `messages` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `conversation_id` INT NOT NULL,
    `user_id` INT NOT NULL,
    `role` ENUM('user', 'assistant', 'system') NOT NULL,
    `content` TEXT NOT NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_messages_conversation` (`conversation_id`),
    CONSTRAINT `fk_messages_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_messages_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table structure for table: audit_logs
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_logs` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT NOT NULL,
    `action` VARCHAR(128) NOT NULL,
    `resource_id` VARCHAR(64) NULL,
    `ip_address` VARCHAR(64) NOT NULL DEFAULT 'unknown',
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_audit_user` (`user_id`),
    CONSTRAINT `fk_audit_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table structure for table: influencers
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `influencers` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `platform` VARCHAR(50) NOT NULL,
    `platform_user_id` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `username` VARCHAR(255) NULL,
    `email` VARCHAR(255) NULL,
    `description` TEXT NULL,
    `profile_image` TEXT NULL,
    `profile_url` TEXT NULL,
    `subscribers` BIGINT NULL,
    `video_count` BIGINT NULL,
    `view_count` BIGINT NULL,
    `location` VARCHAR(64) NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `unique_platform_user` (`platform`, `platform_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `my_influencers` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT NOT NULL,
    `influencer_id` INT NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'saved',
    `notes` TEXT NULL,
    `lastContact` DATETIME NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `unique_user_influencer` (`user_id`, `influencer_id`),
    INDEX `idx_my_inf_user` (`user_id`),
    INDEX `idx_my_inf_influencer` (`influencer_id`),
    CONSTRAINT `fk_my_inf_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_my_inf_influencer` FOREIGN KEY (`influencer_id`) REFERENCES `influencers`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table structure for table: contacts
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `contacts` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `company` VARCHAR(255) NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'active',
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uq_contacts_email` (`email`),
    INDEX `idx_contacts_email` (`email`),
    INDEX `idx_contacts_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table structure for table: campaign_recipients
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `campaign_recipients` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `campaign_id` INT NOT NULL,
    `contact_id` INT NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `sent_at` DATETIME NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uq_cr_campaign_contact` (`campaign_id`, `contact_id`),
    INDEX `idx_cr_campaign` (`campaign_id`),
    INDEX `idx_cr_contact` (`contact_id`),
    CONSTRAINT `fk_cr_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_cr_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table structure for table: email_events
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `email_events` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `campaignId` INT NOT NULL,
    `recipientId` INT NOT NULL,
    `eventType` ENUM('open', 'click') NOT NULL,
    `url` TEXT NULL,
    `timestamp` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `userAgent` TEXT NULL,
    `ipAddress` VARCHAR(64) NULL,
    INDEX `idx_ee_campaign` (`campaignId`),
    INDEX `idx_ee_recipient` (`recipientId`),
    INDEX `idx_ee_type` (`eventType`),
    INDEX `idx_ee_campaign_type` (`campaignId`, `eventType`),
    INDEX `idx_ee_recipient_type` (`recipientId`, `eventType`),
    CONSTRAINT `fk_ee_campaign` FOREIGN KEY (`campaignId`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_ee_recipient` FOREIGN KEY (`recipientId`) REFERENCES `mails`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
