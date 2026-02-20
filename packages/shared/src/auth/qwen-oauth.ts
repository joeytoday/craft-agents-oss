/**
 * Qwen OAuth Authentication
 *
 * Qwen Code uses a CLI-based OAuth flow where the CLI itself
 * handles the browser authentication. This module provides
 * functions to trigger and manage that flow.
 *
 * OAuth flow:
 * 1. Spawn `qwen` CLI process
 * 2. Send `/auth` command
 * 3. CLI opens browser automatically
 * 4. Wait for authentication to complete
 * 5. Extract tokens from Qwen's config file
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, existsSync } from 'node:fs'
import { promisify } from 'node:util'

const readFileAsync = promisify(readFile)

export interface QwenTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

/**
 * Get the path to Qwen's config file
 */
function getQwenConfigPath(): string {
  return join(homedir(), '.qwen', 'config.json')
}

/**
 * Read Qwen's config file and extract tokens
 */
async function readQwenTokens(): Promise<QwenTokens | null> {
  const configPath = getQwenConfigPath()
  
  if (!existsSync(configPath)) {
    return null
  }

  try {
    const configContent = await readFileAsync(configPath, 'utf-8')
    const config = JSON.parse(configContent)
    
    // Qwen stores OAuth tokens in the config
    // Structure may vary, check common locations
    const authConfig = config.auth || config.oauth || config
    
    if (authConfig?.access_token || authConfig?.accessToken) {
      const tokens: QwenTokens = {
        accessToken: authConfig.access_token || authConfig.accessToken,
      }
      
      if (authConfig.refresh_token || authConfig.refreshToken) {
        tokens.refreshToken = authConfig.refresh_token || authConfig.refreshToken
      }
      
      if (authConfig.expires_at || authConfig.expiresAt) {
        tokens.expiresAt = authConfig.expires_at || authConfig.expiresAt
      }
      
      return tokens
    }
    
    return null
  } catch (error) {
    console.error('[Qwen OAuth] Failed to read tokens:', error)
    return null
  }
}

/**
 * Start Qwen OAuth flow by spawning the CLI and triggering /auth
 *
 * The CLI will open the browser automatically.
 * This function waits for the authentication to complete.
 */
export async function startQwenOAuth(
  onStatus?: (message: string) => void
): Promise<void> {
  onStatus?.('Starting Qwen CLI authentication...')

  return new Promise((resolve, reject) => {
    // Spawn qwen CLI process
    const qwenProcess = spawn('qwen', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let outputBuffer = ''
    let authCompleted = false

    qwenProcess.stdout.on('data', (data) => {
      const output = data.toString()
      outputBuffer += output
      
      // Look for authentication prompts or success messages
      if (output.includes('authenticated') || output.includes('login successful')) {
        authCompleted = true
        onStatus?.('Authentication completed!')
        resolve()
      }
    })

    qwenProcess.stderr.on('data', (data) => {
      const error = data.toString()
      console.error('[Qwen OAuth] CLI error:', error)
    })

    qwenProcess.on('error', (error) => {
      if (error.message.includes('ENOENT')) {
        reject(new Error('Qwen CLI not found. Please install it with: npm install -g @qwen-code/qwen-code'))
      } else {
        reject(error)
      }
    })

    qwenProcess.on('exit', (code) => {
      if (!authCompleted && code !== 0) {
        reject(new Error(`Qwen CLI exited with code ${code}`))
      }
    })

    // Send /auth command when the process is ready
    setTimeout(() => {
      qwenProcess.stdin.write('/auth\n')
      onStatus?.('Please complete authentication in your browser...')
    }, 1000)

    // Timeout after 2 minutes
    setTimeout(() => {
      if (!authCompleted) {
        qwenProcess.kill()
        reject(new Error('Authentication timeout. Please try again.'))
      }
    }, 120000)
  })
}

/**
 * Get Qwen OAuth tokens after authentication
 */
export async function getQwenOAuthTokens(): Promise<QwenTokens | null> {
  return await readQwenTokens()
}

/**
 * Check if Qwen CLI is installed
 */
export async function isQwenCliInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn('qwen', ['--version'])
    check.on('error', () => resolve(false))
    check.on('exit', (code) => resolve(code === 0))
  })
}
