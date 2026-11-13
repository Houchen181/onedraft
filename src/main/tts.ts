// Narration with the voices built into Windows (System.Speech / SAPI). Offline and free;
// quality depends on the installed voices (Settings → Time & language → Speech).

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Voice } from '../core/studio'

const SPEAK = `param([string]$TextFile, [string]$Out, [string]$Voice, [int]$Rate)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice) { $s.SelectVoice($Voice) }
$s.Rate = $Rate
$s.SetOutputToWaveFile($Out)
$t = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$s.Speak($t)
$s.Dispose()
`

const LIST = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
foreach ($v in $s.GetInstalledVoices()) { if ($v.Enabled) { $i = $v.VoiceInfo; Write-Output ($i.Name + '|' + $i.Culture.Name + '|' + $i.Gender) } }
$s.Dispose()
`

function ps(script: string, args: string[] = []): Promise<string> {
  const dir = join(tmpdir(), `onedraft-ps-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 's.ps1')
  writeFileSync(file, `﻿${script}`, 'utf8')
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { windowsHide: true })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    // Speech of a long script takes a while, but never this long: a stuck PowerShell must not hang the render.
    const timer = setTimeout(() => p.kill(), 10 * 60_000)
    p.on('close', (code) => {
      clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
      if (code === 0) resolve(out)
      else reject(new Error(`Speech failed: ${err.trim().slice(0, 400)}`))
    })
  })
}

let voiceCache: Voice[] | undefined

export async function listVoices(): Promise<Voice[]> {
  if (process.platform !== 'win32') return []
  voiceCache ??= (await ps(LIST))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [name, culture, gender] = l.split('|')
      return { name, culture, gender }
    })
  return voiceCache
}

/** Speak `text` into a WAV file. Picks a Chinese voice for Chinese text when none is given. */
export async function speak(text: string, out: string, voice?: string, rate = 0): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Narration uses Windows voices; supply your own voice-over file on other systems.')
  let v = voice
  if (!v) {
    const voices = await listVoices()
    const zh = /[一-鿿]/.test(text)
    v = (zh ? voices.find((x) => x.culture.toLowerCase().startsWith('zh')) : voices.find((x) => x.culture.toLowerCase().startsWith('en')))?.name
    if (zh && !v) throw new Error('No Chinese voice is installed. Add one in Windows Settings → Time & language → Speech → Add voices.')
  }
  mkdirSync(dirname(out), { recursive: true })
  const textFile = `${out}.txt`
  writeFileSync(textFile, text, 'utf8')
  try {
    await ps(SPEAK, ['-TextFile', textFile, '-Out', out, '-Voice', v ?? '', '-Rate', String(Math.max(-10, Math.min(10, Math.round(rate))))])
  } finally {
    rmSync(textFile, { force: true })
  }
}
