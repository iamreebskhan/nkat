import { loadOptions, saveOptions } from '../lib/storage';

describe('storage wrapper', () => {
  beforeEach(() => {
    (chrome.storage.sync.get as unknown as jest.Mock).mockReset();
    (chrome.storage.sync.set as unknown as jest.Mock).mockReset();
  });

  it('loadOptions merges stored values over defaults', async () => {
    (chrome.storage.sync.get as jest.Mock).mockResolvedValue({
      backendUrl: 'https://prod',
      orgId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      defaultState: 'NC',
    });
    const opts = await loadOptions();
    expect(opts).toEqual({
      backendUrl: 'https://prod',
      orgId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      defaultState: 'NC',
    });
  });

  it('loadOptions falls back to defaults when storage is empty', async () => {
    (chrome.storage.sync.get as jest.Mock).mockResolvedValue({});
    const opts = await loadOptions();
    expect(opts.backendUrl).toBe('http://localhost:3000');
    expect(opts.orgId).toBe('');
  });

  it('saveOptions writes the supplied object', async () => {
    (chrome.storage.sync.set as jest.Mock).mockResolvedValue(undefined);
    await saveOptions({ backendUrl: 'http://api', orgId: 'o' });
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ backendUrl: 'http://api', orgId: 'o' });
  });
});
