import { describe, expect, it, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseDotEnv, loadDotEnvInto } from './loadDotEnv';

describe('parseDotEnv', () => {
  it('parses basic KEY=value pairs', () => {
    const contents = 'KEY=value';
    expect(parseDotEnv(contents)).toEqual({ KEY: 'value' });
  });

  it('skips comment lines', () => {
    const contents = `
# This is a comment
KEY=value
# Another comment
    `;
    expect(parseDotEnv(contents)).toEqual({ KEY: 'value' });
  });

  it('skips blank lines', () => {
    const contents = `
KEY1=value1

KEY2=value2

    `;
    expect(parseDotEnv(contents)).toEqual({ KEY1: 'value1', KEY2: 'value2' });
  });

  it('strips leading export keyword from keys', () => {
    const contents = 'export KEY=value';
    expect(parseDotEnv(contents)).toEqual({ KEY: 'value' });
  });

  it('strips double quotes from values', () => {
    const contents = 'KEY="quoted value"';
    expect(parseDotEnv(contents)).toEqual({ KEY: 'quoted value' });
  });

  it('strips single quotes from values', () => {
    const contents = "KEY='quoted value'";
    expect(parseDotEnv(contents)).toEqual({ KEY: 'quoted value' });
  });

  it('does not strip unmatched opening quote', () => {
    const contents = 'KEY="value with \' interior quotes';
    expect(parseDotEnv(contents)).toEqual({ KEY: '"value with \' interior quotes' });
  });

  it('trims whitespace around keys', () => {
    const contents = '  KEY  =value';
    expect(parseDotEnv(contents)).toEqual({ KEY: 'value' });
  });

  it('trims whitespace around unquoted values', () => {
    const contents = 'KEY=  value  ';
    expect(parseDotEnv(contents)).toEqual({ KEY: 'value' });
  });

  it('preserves whitespace inside quoted values', () => {
    const contents = 'KEY="  value with spaces  "';
    expect(parseDotEnv(contents)).toEqual({ KEY: '  value with spaces  ' });
  });

  it('preserves values containing equals signs', () => {
    const contents = 'KEY=a=b=c';
    expect(parseDotEnv(contents)).toEqual({ KEY: 'a=b=c' });
  });

  it('handles multiple key=value pairs', () => {
    const contents = `
KEY1=value1
KEY2=value2
KEY3=value3
    `;
    expect(parseDotEnv(contents)).toEqual({
      KEY1: 'value1',
      KEY2: 'value2',
      KEY3: 'value3',
    });
  });

  it('handles export with quotes', () => {
    const contents = 'export KEY="value"';
    expect(parseDotEnv(contents)).toEqual({ KEY: 'value' });
  });

  it('skips lines without an equals sign', () => {
    const contents = `
KEY1=value1
INVALID_LINE_WITHOUT_EQUALS
KEY2=value2
    `;
    expect(parseDotEnv(contents)).toEqual({
      KEY1: 'value1',
      KEY2: 'value2',
    });
  });

  it('handles empty values', () => {
    const contents = 'KEY=';
    expect(parseDotEnv(contents)).toEqual({ KEY: '' });
  });

  it('handles empty quoted values', () => {
    const contents = 'KEY=""';
    expect(parseDotEnv(contents)).toEqual({ KEY: '' });
  });

  it('strips a trailing inline comment from an unquoted value', () => {
    const contents = 'ANTHROPIC_API_KEY=sk-ant-abc123 # work key';
    expect(parseDotEnv(contents)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-abc123' });
  });

  it('preserves a quoted value containing a hash', () => {
    const contents = 'KEY="value # not a comment"';
    expect(parseDotEnv(contents)).toEqual({ KEY: 'value # not a comment' });
  });
});

describe('loadDotEnvInto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'load-dot-env-test-'));
  const envPath = join(dir, '.env');

  afterEach(() => {
    rmSync(envPath, { force: true });
  });

  it('reads and parses a .env file', () => {
    writeFileSync(envPath, 'KEY=value', 'utf-8');
    const target: NodeJS.ProcessEnv = {};
    loadDotEnvInto(envPath, target);
    expect(target.KEY).toBe('value');
  });

  it('does not throw when the file does not exist', () => {
    const nonexistentPath = join(dir, 'nonexistent.env');
    const target: NodeJS.ProcessEnv = {};
    expect(() => loadDotEnvInto(nonexistentPath, target)).not.toThrow();
  });

  it('loads multiple key-value pairs', () => {
    writeFileSync(envPath, 'KEY1=value1\nKEY2=value2', 'utf-8');
    const target: NodeJS.ProcessEnv = {};
    loadDotEnvInto(envPath, target);
    expect(target.KEY1).toBe('value1');
    expect(target.KEY2).toBe('value2');
  });

  it('does not overwrite keys already set in target', () => {
    writeFileSync(envPath, 'KEY=from-file', 'utf-8');
    const target: NodeJS.ProcessEnv = { KEY: 'already-set' };
    loadDotEnvInto(envPath, target);
    expect(target.KEY).toBe('already-set');
  });

  it('assigns keys from .env that are not already set', () => {
    writeFileSync(envPath, 'NEW_KEY=new-value\nEXISTING_KEY=ignored', 'utf-8');
    const target: NodeJS.ProcessEnv = { EXISTING_KEY: 'original' };
    loadDotEnvInto(envPath, target);
    expect(target.NEW_KEY).toBe('new-value');
    expect(target.EXISTING_KEY).toBe('original');
  });

  it('handles .env files with comments and blank lines', () => {
    writeFileSync(envPath, `
# Comment
KEY1=value1

KEY2=value2
# Another comment
    `, 'utf-8');
    const target: NodeJS.ProcessEnv = {};
    loadDotEnvInto(envPath, target);
    expect(target.KEY1).toBe('value1');
    expect(target.KEY2).toBe('value2');
  });

  it('respects quoted values', () => {
    writeFileSync(envPath, 'KEY="quoted value"', 'utf-8');
    const target: NodeJS.ProcessEnv = {};
    loadDotEnvInto(envPath, target);
    expect(target.KEY).toBe('quoted value');
  });
});
