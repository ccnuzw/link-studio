declare module "fs-native-extensions" {
  export function tryLock(descriptor: number): boolean;
  export function unlock(descriptor: number): void;
}
