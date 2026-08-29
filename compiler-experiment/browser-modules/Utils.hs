{-# LANGUAGE ImportQualifiedPost #-}

module Utils
  ( plusInteger
  ) where

import PlutusTx.Prelude qualified as Plinth

plusInteger :: Integer -> Integer -> Integer
plusInteger x y = x Plinth.+ y
