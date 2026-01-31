/**
 * URL Validator Tests
 *
 * Tests for SSRF protection and URL validation in the news plugin.
 */

import { describe, it, expect } from 'vitest';
import {
  validateUrl,
  validateTelegramHandle,
} from '../../../../src/plugins/news/url-validator.js';

describe('URL Validator', () => {
  describe('validateUrl - valid URLs', () => {
    it('should accept valid HTTPS URLs', () => {
      const result = validateUrl('https://example.com/feed.xml');
      expect(result.valid).toBe(true);
      expect(result.url).toBe('https://example.com/feed.xml');
    });

    it('should accept valid HTTP URLs', () => {
      const result = validateUrl('http://example.com/rss');
      expect(result.valid).toBe(true);
      expect(result.url).toBe('http://example.com/rss');
    });

    it('should normalize URLs', () => {
      const result = validateUrl('  https://EXAMPLE.COM/feed  ');
      expect(result.valid).toBe(true);
      expect(result.url).toBe('https://example.com/feed');
    });

    it('should accept URLs with ports', () => {
      const result = validateUrl('https://example.com:8080/feed');
      expect(result.valid).toBe(true);
    });

    it('should accept URLs with paths and query strings', () => {
      const result = validateUrl('https://news.site/api/feed?format=rss&lang=en');
      expect(result.valid).toBe(true);
    });
  });

  describe('validateUrl - SSRF protection: private IPs', () => {
    it('should block localhost', () => {
      const result = validateUrl('http://localhost/feed');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('private or reserved');
    });

    it('should block localhost.localdomain', () => {
      const result = validateUrl('http://localhost.localdomain/feed');
      expect(result.valid).toBe(false);
    });

    it('should block 127.0.0.1', () => {
      const result = validateUrl('http://127.0.0.1/feed');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('private or reserved');
    });

    it('should block 127.x.x.x range', () => {
      const result = validateUrl('http://127.1.2.3/feed');
      expect(result.valid).toBe(false);
    });

    it('should block 10.x.x.x (private)', () => {
      const result = validateUrl('http://10.0.0.1/feed');
      expect(result.valid).toBe(false);
    });

    it('should block 192.168.x.x (private)', () => {
      const result = validateUrl('http://192.168.1.1/feed');
      expect(result.valid).toBe(false);
    });

    it('should block 172.16-31.x.x (private)', () => {
      expect(validateUrl('http://172.16.0.1/feed').valid).toBe(false);
      expect(validateUrl('http://172.20.0.1/feed').valid).toBe(false);
      expect(validateUrl('http://172.31.255.255/feed').valid).toBe(false);
    });

    it('should allow 172.15.x.x and 172.32.x.x (not private)', () => {
      // These are outside the private range - but still blocked as they're internal
      // Actually 172.15.x.x is public, let's test
      const result = validateUrl('http://172.15.0.1/feed');
      // This should be allowed as it's not in the private range
      expect(result.valid).toBe(true);
    });
  });

  describe('validateUrl - SSRF protection: cloud metadata', () => {
    it('should block AWS metadata endpoint', () => {
      const result = validateUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.valid).toBe(false);
    });

    it('should block link-local addresses', () => {
      const result = validateUrl('http://169.254.1.1/');
      expect(result.valid).toBe(false);
    });

    it('should block metadata.google.internal', () => {
      const result = validateUrl('http://metadata.google.internal/');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateUrl - SSRF protection: protocols', () => {
    it('should block file:// protocol', () => {
      const result = validateUrl('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Protocol not allowed');
    });

    it('should block javascript: protocol', () => {
      const result = validateUrl('javascript:alert(1)');
      expect(result.valid).toBe(false);
    });

    it('should block data: protocol', () => {
      const result = validateUrl('data:text/html,<script>alert(1)</script>');
      expect(result.valid).toBe(false);
    });

    it('should block ftp: protocol', () => {
      const result = validateUrl('ftp://example.com/feed');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateUrl - SSRF protection: internal domains', () => {
    it('should block .local domains', () => {
      const result = validateUrl('http://server.local/feed');
      expect(result.valid).toBe(false);
    });

    it('should block .internal domains', () => {
      const result = validateUrl('http://api.internal/feed');
      expect(result.valid).toBe(false);
    });

    it('should block .corp domains', () => {
      const result = validateUrl('http://intranet.corp/feed');
      expect(result.valid).toBe(false);
    });

    it('should block single-word hostnames (intranet)', () => {
      const result = validateUrl('http://intranet/feed');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('internal/intranet');
    });
  });

  describe('validateUrl - SSRF protection: dangerous ports', () => {
    it('should block SSH port 22', () => {
      const result = validateUrl('http://example.com:22/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Port 22');
    });

    it('should block Redis port 6379', () => {
      const result = validateUrl('http://example.com:6379/');
      expect(result.valid).toBe(false);
    });

    it('should block MySQL port 3306', () => {
      const result = validateUrl('http://example.com:3306/');
      expect(result.valid).toBe(false);
    });

    it('should block MongoDB port 27017', () => {
      const result = validateUrl('http://example.com:27017/');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateUrl - security: credentials', () => {
    it('should block URLs with embedded credentials', () => {
      const result = validateUrl('http://user:pass@example.com/feed');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('credentials');
    });

    it('should block URLs with just username', () => {
      const result = validateUrl('http://admin@example.com/feed');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateUrl - edge cases', () => {
    it('should reject empty URLs', () => {
      const result = validateUrl('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject whitespace-only URLs', () => {
      const result = validateUrl('   ');
      expect(result.valid).toBe(false);
    });

    it('should reject invalid URL format', () => {
      const result = validateUrl('not a url');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid URL');
    });

    it('should reject URL without hostname', () => {
      const result = validateUrl('http:///path');
      expect(result.valid).toBe(false);
    });
  });
});

describe('Telegram Handle Validator', () => {
  describe('valid handles', () => {
    it('should accept valid handle with @', () => {
      const result = validateTelegramHandle('@techcrunch');
      expect(result.valid).toBe(true);
      expect(result.url).toBe('@techcrunch');
    });

    it('should accept valid handle without @', () => {
      const result = validateTelegramHandle('bbcnews');
      expect(result.valid).toBe(true);
      expect(result.url).toBe('@bbcnews');
    });

    it('should normalize handle by adding @', () => {
      const result = validateTelegramHandle('cnnbrk');
      expect(result.url).toBe('@cnnbrk');
    });

    it('should accept handle with underscores', () => {
      const result = validateTelegramHandle('@tech_news_daily');
      expect(result.valid).toBe(true);
    });

    it('should accept handle with numbers', () => {
      const result = validateTelegramHandle('@news24x7');
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid handles', () => {
    it('should reject empty handle', () => {
      const result = validateTelegramHandle('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject handle shorter than 5 characters', () => {
      const result = validateTelegramHandle('@abc');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('5-32');
    });

    it('should reject handle longer than 32 characters', () => {
      const result = validateTelegramHandle('@' + 'a'.repeat(33));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('5-32');
    });

    it('should reject handle with consecutive underscores', () => {
      const result = validateTelegramHandle('@tech__news');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('consecutive underscores');
    });

    it('should reject handle starting with number', () => {
      const result = validateTelegramHandle('@123news');
      expect(result.valid).toBe(false);
    });

    it('should reject handle with special characters', () => {
      const result = validateTelegramHandle('@tech-news');
      expect(result.valid).toBe(false);
    });
  });
});
