
export interface TranscriptionEntry {
  role: 'user' | 'teacher';
  text: string;
}

export interface TeacherState {
  isConnecting: boolean;
  isActive: boolean;
  error: string | null;
}
