// Общее звено записей в хранилище моста: один порядок на всех писателей.
// Выделено из snapshot.ts, чтобы снимок и очередь правок не завели по цепочке.

/** Идущая запись: вторая встаёт за первой — хранилище моста про транзакции не знает. */
let chain: Promise<void> = Promise.resolve()

export function serial<T>(task: () => Promise<T>): Promise<T> {
  const done = chain.then(task)
  chain = done.then(
    () => undefined,
    () => undefined,
  )
  return done
}

/** Отказ задачи цепочку не рвёт; наружу — обещание задачи, а не цепочки. */
export function serialWrite(task: () => Promise<void>): Promise<void> {
  return serial(task)
}
