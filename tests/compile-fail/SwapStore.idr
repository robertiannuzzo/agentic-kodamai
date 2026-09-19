module SwapStore
import Recruitment.Adapters.Memory
%default total

bad : (old, edited : Advert) -> Memory old -> Memory edited
bad old edited store = store
