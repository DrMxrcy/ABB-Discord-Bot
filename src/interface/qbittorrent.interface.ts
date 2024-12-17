import { ButtonInteraction } from 'discord.js';

export interface QBittorrentConfig {
    baseUrl: string;
    username: string;
    password: string;
}

export interface Task {
    (): Promise<void>;
}

export interface TorrentData {
    id: string;
    state: string;
    name: string;
    isCompleted: boolean;
    save_path?: string;
    content_path?: string;
    progress?: number;
    size?: number;
    downloaded?: number;
    files?: TorrentFile[];
}

export interface TorrentFile {
    name: string;
    size: number;
    progress: number;
    priority: number;
    is_seed: boolean;
    piece_range: number[];
    availability: number;
}

export interface AllData {
    torrents: TorrentData[];
}

export interface DownloadingData {
    userId: string;
    bookName: string;
    i: ButtonInteraction;
    embedSent: boolean;
}

export interface ExecResult {
    stdout: string;
    stderr: string;
}

export interface QBittorrentPaths {
  basePath: string;
  downloadPath: string;
  completedPath: string;
  outputPath: string;
}