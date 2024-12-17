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
    hash: string;
    size: number;
    progress: number;
    dlspeed: number;
    upspeed: number;
    priority: number;
    num_seeds: number;
    num_complete: number;
    num_leechs: number;
    num_incomplete: number;
    ratio: number;
    eta: number;
    category: string;
    tags: string;
    save_path?: string;
    content_path?: string;
    added_on: number;
    completion_on: number;
    tracker: string;
    dl_limit: number;
    up_limit: number;
    downloaded: number;
    uploaded: number;
    downloaded_session: number;
    uploaded_session: number;
    amount_left: number;
    completed: number;
    max_ratio: number;
    max_seeding_time: number;
    auto_tmm: boolean;
    force_start: boolean;
    super_seeding: boolean;
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