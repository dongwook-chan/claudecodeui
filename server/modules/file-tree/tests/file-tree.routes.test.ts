import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('file read routes preserve absolute links with spaces and non-ASCII names', async () => {
  const filePath = '/home/user/.codex/skills/production review 한글.ko.md';
  const content = '# Production review\n프로젝트 밖 문서\n';
  const reads: Parameters<FileTreeServices['readTextFile']>[] = [];
  const streams: Parameters<FileTreeServices['openFile']>[] = [];
  const services = createFakeServices({
    readTextFile: async (...input) => {
      reads.push(input);
      return { path: filePath, content };
    },
    openFile: async (...input) => {
      streams.push(input);
      return { contentType: 'text/markdown; charset=utf-8', stream: Readable.from([content]) };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const textResponse = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/file?${new URLSearchParams({ filePath })}`,
    );
    assert.equal(textResponse.status, 200);
    assert.deepEqual(await textResponse.json(), { path: filePath, content });

    const streamResponse = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files/content?${new URLSearchParams({ path: filePath })}`,
    );
    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(await streamResponse.text(), content);
  });

  assert.deepEqual(reads, [['project-1', filePath]]);
  assert.deepEqual(streams, [['project-1', filePath]]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});
