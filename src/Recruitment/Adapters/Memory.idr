module Recruitment.Adapters.Memory

import public Recruitment.Application.Ports

%default total

export
data Memory : Advert -> Type where
  Entries : List (RawApplication, Receipt a) -> Memory a

export
empty : Memory a
empty = Entries []

export
entryCount : Memory a -> Nat
entryCount (Entries rows) = length rows

findEntry : Nat -> List (RawApplication, Receipt a) -> Maybe (RawApplication, Receipt a)
findEntry _ [] = Nothing
findEntry key ((raw, receipt) :: rest) =
  if raw.identifier == key then Just (raw, receipt) else findEntry key rest

commit : RawApplication -> (() -> Either DomainError (Receipt a)) -> Memory a ->
         Either DomainError (Receipt a, Memory a)
commit raw work (Entries rows) =
  case findEntry raw.identifier rows of
    Just (original, receipt) =>
      if original == raw then Right (receipt, Entries rows) else Left IdempotencyConflict
    Nothing => do
      receipt <- work ()
      Right (receipt, Entries ((raw, receipt) :: rows))

export
memoryRepository : Repository a (Memory a)
memoryRepository = MkRepository commit

||| Test adapter: failed commits return no new state or success receipt.
export
unavailableRepository : Repository a (Memory a)
unavailableRepository = MkRepository (\_, _, _ => Left PersistenceFailed)
