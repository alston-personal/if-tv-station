import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execPromise = promisify(exec);

export async function GET() {
  try {
    const pythonBin = process.env.AGENT_PYTHON_BIN || 'python3';
    const scriptPath = path.join(process.cwd(), 'src', 'lib', 'list_channels.py');
    const cmd = `"${pythonBin}" "${scriptPath}"`;

    console.log(`[API][Channels] Querying channel list: ${cmd}`);
    const { stdout } = await execPromise(cmd);

    try {
      const channels = JSON.parse(stdout.trim());
      return NextResponse.json(channels);
    } catch {
      return NextResponse.json({ error: 'Failed to parse channel list' }, { status: 500 });
    }
  } catch (error: any) {
    console.error('[API][Channels] Error listing channels:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
